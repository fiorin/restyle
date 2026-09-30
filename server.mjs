import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadArtDir, fileHash, ROOT } from './lib/artdir.mjs';
import { renderImage, buildPrompt, PROVIDERS } from './lib/render.mjs';
import { Manifest } from './lib/manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const WORK_DIR = path.join(ROOT, 'work');
const PORT = Number(process.env.PORT || 3488);

/**
 * `token` é a chave do OpenAI e `geminiKey` a do Google. Ambos opcionais: dá
 * pra rodar 100% no Gemini, que tem free tier, sem gastar nada.
 */
const DEFAULT_CONFIG = {
  provider: 'gemini',
  token: '',
  geminiKey: '',
  sourceDir: '',
  outputDir: path.join(ROOT, 'out'),
  renderModel: '',
  geminiModel: '',
  quality: 'high',
  maxPixels: 2160,
  useStyleAnchor: true,
  useRefs: true,
  variants: 1,
  concurrency: 1,
};

/** Chave do provider ativo, resolvida por nome. */
function keyFor(config, provider) {
  return provider === 'openai' ? config.token : provider === 'gemini' ? config.geminiKey : '';
}

/** Model vazio = default do provider. */
function modelFor(config, provider, draft) {
  const p = PROVIDERS[provider];
  const configured = provider === 'gemini' ? config.geminiModel : config.renderModel;
  if (configured) return configured;
  return draft ? p.draftModel : p.defaultModel;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

/**
 * Lê JSON tolerando BOM. Arquivos escritos pelo PowerShell 5.1 (`-Encoding utf8`)
 * e pelo Bloco de Notas vêm com BOM, e `JSON.parse` rejeita BOM sem explicar.
 */
function readJsonFile(abs) {
  return JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''));
}

const KNOWN = new Set(Object.keys(DEFAULT_CONFIG));

/**
 * Só as chaves conhecidas entram no config. Sem esse filtro, settings que
 * deixaram de existir (`textModel`, `qa`, `qaThreshold`, `qaMaxAttempts`) ficavam
 * presos no config.json para sempre, e apareciam como se ainda fizessem sentido.
 */
function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    /* config ausente ou corrompido: usa os defaults */
  }
  const out = { ...DEFAULT_CONFIG };
  for (const [k, v] of Object.entries(saved)) if (KNOWN.has(k)) out[k] = v;
  return out;
}

function saveConfig(c) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

let artDir = loadArtDir(ROOT);
let manifest = new Manifest(WORK_DIR);
const jobs = new Map();

// ---------------------------------------------------------------- helpers

function sendJson(res, data, code = 200) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendStatic(res, name) {
  const file = path.join(PUBLIC_DIR, name);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end('not found');
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Length': body.length,
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 16 * 1024 * 1024) reject(new Error('payload muito grande'));
    });
    req.on('end', () => {
      // BOM: o PowerShell 5.1 prefixa string bodies com BOM, e `JSON.parse`
      // rejeita BOM sem explicar nada. Mesma tolerância dos arquivos.
      try {
        resolve(data ? JSON.parse(data.replace(/^\uFEFF/, '')) : {});
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

/** Corpo malformado é erro do cliente (400), não do servidor (500). */
async function readBody(req, res) {
  try {
    return await readJson(req);
  } catch (e) {
    sendJson(res, { error: e.message }, 400);
    return null;
  }
}

/** Servir arquivo de dentro de uma allowlist de raízes — nada de path traversal. */
function serveImage(res, abs) {
  const resolved = path.resolve(abs);
  const allowed = [manifest.workDir, loadConfig().outputDir, WORK_DIR].filter(Boolean).map((d) => path.resolve(d));
  if (!allowed.some((d) => resolved.startsWith(d))) {
    res.writeHead(403);
    return res.end('fora das pastas permitidas');
  }
  if (!fs.existsSync(resolved)) {
    res.writeHead(404);
    return res.end('not found');
  }
  const body = fs.readFileSync(resolved);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      // Rate limit e 5xx valem retry; 4xx de prompt não.
      const retriable = /429|500|502|503|504|fetch failed|ECONNRESET|ETIMEDOUT/i.test(e.message);
      if (!retriable || i === attempts) break;
      await sleep(Math.min(1000 * 2 ** (i - 1), 15000));
    }
  }
  throw last;
}

function scanImages(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (IMAGE_RE.test(e.name)) out.push(full);
    }
  };
  walk(dir, 0);
  return out.sort();
}

/** Resolve o subject: nome do arquivo + sidecar .json opcional com nome/descrição. */
function subjectFor(imagePath) {
  const stem = path.basename(imagePath, path.extname(imagePath));
  const sidecar = imagePath.replace(IMAGE_RE, '.json');
  let name = stem;
  let description = '';
  if (fs.existsSync(sidecar)) {
    try {
      const j = readJsonFile(sidecar);
      name = j.name ?? stem;
      description = j.description ?? '';
    } catch {
      // Sidecar inválido: seguimos só com o nome do arquivo, sem travar o scan.
    }
  }
  return { name, description, stem };
}

// ---------------------------------------------------------------- jobs

async function runJob(job) {
  const c = loadConfig();
  fs.mkdirSync(c.outputDir, { recursive: true });
  fs.mkdirSync(path.join(c.outputDir, job.name), { recursive: true });
  job.status = 'running';
  job.startedAt = new Date().toISOString();

  const provider = job.provider || c.provider;
  const apiKey = keyFor(c, provider);
  if (!apiKey) throw new Error(`chave de "${provider}" não configurada`);

  const model = modelFor(c, provider, job.draft);
  const quality = job.draft ? 'low' : c.quality;
  const variants = Math.max(1, Math.min(Number(job.variants) || 1, 4));

  for (const item of job.items) {
    if (job.cancelled) break;
    const rec = { ...item, state: 'working', message: 'iniciando' };
    job.items[job.items.indexOf(item)] = rec;

    try {
      if (!fs.existsSync(item.source)) throw new Error('fonte sumiu: ' + item.source);

      const srcHash = fileHash(item.source);
      const subject = subjectFor(item.source);

      rec.message = 'montando prompt a partir do card';
      const built = buildPrompt({
        card: artDir.card,
        style: job.style,
        subjectName: subject.name,
        extra: subject.description ? [subject.description] : [],
      });
      rec.prompt = built.prompt;
      rec.subject = subject;
      rec.styleName = built.styleName;

      const refs = [];
      if (c.useStyleAnchor) {
        const anchor = artDir.refs.find((r) => /style-anchor/i.test(r));
        if (anchor) refs.push(anchor);
      }
      if (c.useRefs) refs.push(...artDir.refs.filter((r) => !/style-anchor/i.test(r)));

      const key = Manifest.key({
        artDirHash: artDir.hash,
        sourceHash: srcHash,
        prompt: built.prompt,
        provider,
        model,
        quality,
        aspect: built.aspect,
        style: job.style,
      });
      rec.key = key;

      const hit = manifest.get(key);
      if (hit && fs.existsSync(hit.output) && !job.force) {
        rec.state = 'skipped';
        rec.message = `já gerado com esta direção de arte (estilo ${built.styleName})`;
        rec.output = hit.output;
        rec.thumbUrl = `/api/image?p=${encodeURIComponent(hit.output)}`;
        rec.artDirHash = artDir.hash;
        job.stats.skipped++;
        continue;
      }

      // N variantes da MESMA fonte e prompt. Sem QA numérico de LLM, a escolha
      // final é visual — então é mais útil gastar a cota em alternativas do que
      // num score que ninguém pediu.
      rec.outputs = [];
      for (let v = 1; v <= variants; v++) {
        if (job.cancelled) break;
        rec.message = `renderizando ${v}/${variants} (estilo ${built.styleName})`;
        const out = await withRetry(() =>
          renderImage({
            provider,
            key: apiKey,
            sourcePath: item.source,
            prompt: built.prompt,
            refs,
            model,
            quality,
            aspect: built.aspect,
            maxPixels: Number(c.maxPixels) || 2160,
          }),
        );

        const name = variants > 1 ? `${subject.stem}__${built.styleName}__v${v}.png` : `${subject.stem}.png`;
        const abs = path.join(c.outputDir, job.name, name);
        fs.writeFileSync(abs, out.buffer);

        rec.outputs.push({ path: abs, url: `/api/image?p=${encodeURIComponent(abs)}` });
        rec.output = abs;
        rec.thumbUrl = rec.outputs.at(-1).url;
      }

      rec.state = 'done';
      rec.message = `ok — ${rec.outputs.length} variante(s) do estilo ${built.styleName}`;
      rec.sourceUrl = `/api/image?p=${encodeURIComponent(path.resolve(item.source))}`;
      rec.artDirHash = artDir.hash;
      job.stats.done++;

      manifest.put({
        key,
        source: path.resolve(item.source),
        output: rec.output,
        outputs: rec.outputs.map((o) => o.path),
        prompt: built.prompt,
        provider,
        model,
        quality,
        aspect: built.aspect,
        style: job.style,
        styleName: built.styleName,
        artDirHash: artDir.hash,
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      rec.state = 'error';
      rec.message = e.message;
      job.stats.error++;
    }
  }

  job.status = job.cancelled ? 'cancelled' : 'done';
  job.finishedAt = new Date().toISOString();
  job.outputDir = path.join(c.outputDir, job.name);
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (req.method === 'GET' && url.pathname === '/') return sendStatic(res, 'index.html');
    if (req.method === 'GET' && url.pathname === '/app.js') return sendStatic(res, 'app.js');
    if (req.method === 'GET' && url.pathname === '/style.css') return sendStatic(res, 'style.css');

    if (url.pathname === '/api/image') {
      const p = url.searchParams.get('p');
      if (!p) return sendJson(res, { error: 'p obrigatório' }, 400);
      return serveImage(res, p);
    }

    if (url.pathname === '/api/settings') {
      const c = loadConfig();
      if (req.method === 'GET') {
        // As chaves NÃO voltam: só os indicadores. Não há auth neste servidor
        // (é loopback), mas devolver o segredo inteiro em qualquer GET é o tipo
        // de coisa que aparece num log ou print de debug depois.
        const { token, geminiKey, ...safe } = c;
        return sendJson(res, {
          ...safe,
          tokenSet: !!token,
          tokenHint: token ? token.slice(-6) : '',
          geminiKeySet: !!geminiKey,
          geminiKeyHint: geminiKey ? geminiKey.slice(-6) : '',
          providers: Object.fromEntries(
            Object.entries(PROVIDERS).map(([k, v]) => [k, { defaultModel: v.defaultModel, draftModel: v.draftModel }]),
          ),
          sourceExists: !!(c.sourceDir && fs.existsSync(c.sourceDir)),
        });
      }
      if (req.method === 'POST') {
        const body = await readBody(req, res);
        if (!body) return;
        const next = { ...c };
        const numeric = ['maxPixels', 'concurrency', 'variants'];
        // As chaves ficam de fora do loop genérico: ele aceitaria string vazia,
        // e a UI manda vazio justamente para dizer "mantenha a atual".
        const secrets = new Set(['token', 'geminiKey']);
        for (const k of Object.keys(DEFAULT_CONFIG)) {
          if (body[k] === undefined || secrets.has(k)) continue;
          next[k] = numeric.includes(k) ? Number(body[k]) : body[k];
        }
        // String vazia = manter a chave atual, senão a UI não consegue mais salvar.
        //
        // O `clear` é checado FORA do `continue`: um pedido de limpeza manda só
        // `clearToken`, sem `token`. Dentro do continue, limpar nunca funcionava.
        for (const field of secrets) {
          const clearField = 'clear' + field[0].toUpperCase() + field.slice(1);
          if (body[clearField]) next[field] = '';
          if (body[field] === undefined) continue;
          const v = String(body[field] || '').trim();
          if (v) next[field] = v;
        }
        saveConfig(next);
        return sendJson(res, {
          ok: true,
          tokenSet: !!next.token,
          tokenHint: next.token ? next.token.slice(-6) : '',
          geminiKeySet: !!next.geminiKey,
          geminiKeyHint: next.geminiKey ? next.geminiKey.slice(-6) : '',
        });
      }
    }

    /** Estilos disponíveis, direto do card — a UI não deve hardcodar A/B/C. */
    if (req.method === 'GET' && url.pathname === '/api/styles') {
      return sendJson(res, {
        hash: artDir.hash,
        error: artDir.cardError,
        styles: Object.entries(artDir.card?.styles ?? {}).map(([id, s]) => ({
          id,
          name: s.name ?? id,
          aspect: s.aspect ?? '3:4',
          clean_distressed: s.clean_distressed ?? null,
          traits: s.traits ?? [],
          negatives: (artDir.card?.negative_by_style?.[id] ?? []).length,
        })),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/artdir') {
      artDir = loadArtDir(ROOT);
      return sendJson(res, {
        hash: artDir.hash,
        md: artDir.md,
        card: artDir.card,
        cardError: artDir.cardError,
        refs: artDir.refs,
        mdPath: artDir.mdPath,
        yamlPath: artDir.yamlPath,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/artdir/reload') {
      artDir = loadArtDir(ROOT);
      manifest = new Manifest(WORK_DIR);
      return sendJson(res, { ok: true, hash: artDir.hash, refs: artDir.refs.length });
    }

    if (req.method === 'GET' && url.pathname === '/api/scan') {
      const c = loadConfig();
      const dir = url.searchParams.get('dir') || c.sourceDir;
      if (!dir) return sendJson(res, { error: 'sourceDir não configurado' }, 400);
      const files = scanImages(dir);
      return sendJson(res, {
        dir,
        count: files.length,
        files: files.map((f) => {
          const s = subjectFor(f);
          const history = manifest.findBySource(path.resolve(f));
          return {
            path: f,
            name: s.name,
            description: s.description,
            url: `/api/image?p=${encodeURIComponent(path.resolve(f))}`,
            stale: history.length ? history.every((h) => h.artDirHash !== artDir.hash) : false,
            lastOutput: history.length ? history[history.length - 1].output : null,
            lastStyle: history.length ? history[history.length - 1].styleName ?? null : null,
          };
        }),
      });
    }

    /**
 * Preview do prompt: monta a partir do card e devolve. Não chama NENHUMA API
 * externa e não precisa de chave — é só a função de montagem, então dá pra
 * iterar no texto de graça antes de gastar uma geração.
 */
if (req.method === 'POST' && url.pathname === '/api/preview') {
      const body = await readBody(req, res);
      if (!body) return;
      const style = String(body.style || 'A');
      if (!artDir.card?.styles?.[style]) return sendJson(res, { error: `estilo "${style}" não existe no card` }, 400);
      const subject = body.path ? subjectFor(body.path) : { name: '', description: '' };
      try {
        const built = buildPrompt({
          card: artDir.card,
          style,
          subjectName: subject.name,
          extra: subject.description ? [subject.description] : [],
        });
        return sendJson(res, { ok: true, ...built });
      } catch (e) {
        return sendJson(res, { error: e.message }, 400);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/render') {
      const body = await readBody(req, res);
      if (!body) return;
      const c = loadConfig();
      const provider = body.provider || c.provider;
      if (!PROVIDERS[provider]) return sendJson(res, { error: `provider desconhecido: ${provider}` }, 400);
      if (!keyFor(c, provider)) return sendJson(res, { error: `chave de "${provider}" não configurada` }, 400);

      const style = String(body.style || 'A');
      if (!artDir.card?.styles?.[style]) {
        return sendJson(res, { error: `estilo "${style}" não existe no card` }, 400);
      }

      const files = (body.files || []).filter((f) => f && fs.existsSync(f));
      if (!files.length) return sendJson(res, { error: 'nenhuma imagem válida' }, 400);

      const id = 'job_' + Date.now().toString(36);
      const job = {
        id,
        name: String(body.name || id).replace(/[^\w.-]+/g, '_'),
        draft: !!body.draft,
        force: !!body.force,
        provider,
        style,
        variants: Number(body.variants) || c.variants || 1,
        status: 'queued',
        cancelled: false,
        artDirHash: artDir.hash,
        items: files.map((f) => ({ source: f, state: 'pending', message: 'na fila' })),
        stats: { done: 0, error: 0, skipped: 0 },
      };
      jobs.set(id, job);
      if (jobs.size > 20) jobs.delete(jobs.keys().next().value);
      runJob(job).catch((e) => {
        job.status = 'done';
        job.error = e.message;
      });
      return sendJson(res, { id, name: job.name, count: job.items.length, style, provider });
    }

    if (req.method === 'GET' && url.pathname === '/api/job') {
      const job = jobs.get(url.searchParams.get('id') || '');
      if (!job) return sendJson(res, { error: 'job não encontrado' }, 404);
      return sendJson(res, job);
    }

    if (req.method === 'POST' && url.pathname === '/api/job/cancel') {
      const body = await readBody(req, res);
      if (!body) return;
      const job = jobs.get(body.id);
      if (!job) return sendJson(res, { error: 'job não encontrado' }, 404);
      job.cancelled = true;
      return sendJson(res, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/open') {
      const body = await readBody(req, res);
      if (!body) return;
      const c = loadConfig();
      const dir = String(body.dir || path.join(c.outputDir, body.name || ''));
      fs.mkdirSync(dir, { recursive: true });
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
      return sendJson(res, { ok: true, dir });
    }

    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    sendJson(res, { error: e.message }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const c = loadConfig();
  const styles = Object.keys(artDir.card?.styles ?? {});
  console.log(`restyle em http://127.0.0.1:${PORT}`);
  console.log(`provider: ${c.provider} (${keyFor(c, c.provider) ? 'chave ok' : 'SEM CHAVE'})`);
  console.log(`direção de arte: ${artDir.mdPath} (hash ${artDir.hash.slice(0, 8)})`);
  console.log(`estilos: ${styles.length ? styles.join(', ') : 'nenhum'}  |  refs: ${artDir.refs.length}  |  saída: ${c.outputDir}`);
  if (artDir.cardError) console.warn(`AVISO no art-direction.yaml: ${artDir.cardError}`);
  if (!styles.length) console.warn('AVISO: card sem styles — nenhum estilo pode ser selecionado');
  if (!artDir.refs.length) console.warn('AVISO: refs/ vazio — consistência de estilo vai depender só do prompt');
});
