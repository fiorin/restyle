/**
 * E2E do servidor contra um MOCK HTTP do provider de imagem.
 *
 * Não há chave real aqui e não há chamada de texto: o teste sobe um servidor
 * que finge ser o Gemini, aponta GEMINI_BASE para ele, e valida o pipeline
 * inteiro (rotas, idempotência, colisão de estilo, variantes).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

import { loadArtDir } from '../lib/artdir.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = 3491;
const BASE = `http://127.0.0.1:${PORT}`;

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- mock

/** Requisições que o mock recebeu — é o que permite checar prompt e ordem. */
const seen = [];

/** Quantos campos `image`/`inline_data` vieram, na ordem em que chegaram. */
function countImageParts(body) {
  const parts = body?.contents?.[0]?.parts ?? [];
  const inline = parts.filter((p) => p.inline_data || p.inlineData).length;
  return { total: parts.length, images: inline, hasText: parts.some((p) => typeof p.text === 'string') };
}

const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const send = (code, obj) => {
      const b = Buffer.from(JSON.stringify(obj));
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
      res.end(b);
    };

    if (req.url.startsWith('/v1beta/models/') && req.url.includes(':generateContent')) {
      let body = {};
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        /* mock não se importa */
      }
      seen.push({
        kind: 'gemini',
        url: req.url,
        parts: countImageParts(body),
        prompt: body?.contents?.[0]?.parts?.find((p) => p.text)?.text ?? '',
        modalities: body?.generationConfig?.responseModalities ?? null,
        aspect: body?.generationConfig?.imageConfig?.aspectRatio ?? null,
      });
      return send(200, {
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_1PX.toString('base64') } }] } }],
      });
    }

    if (req.url.startsWith('/v1/images/edits')) {
      seen.push({ kind: 'openai', url: req.url, prompt: raw.toString('utf8').slice(0, 400) });
      return send(200, { data: [{ b64_json: PNG_1PX.toString('base64') }] });
    }

    send(404, { error: { message: 'mock: rota desconhecida' } });
  });
});

const waitFor = async (url, tries = 80) => {
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url);
    } catch {
      await sleep(120);
    }
  }
  throw new Error(`não subiu: ${url}`);
};

// ---------------------------------------------------------------- harness

let server;
let tmp;
let sourceDir;
let stderr = '';

const get = async (p) => {
  const res = await fetch(BASE + p);
  return { status: res.status, body: await res.json() };
};

const post = async (p, obj, rawBody) => {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody ?? JSON.stringify(obj),
  });
  return { status: res.status, body: await res.json() };
};

async function runRender(payload) {
  const { status, body } = await post('/api/render', payload);
  assert.equal(status, 200, `render recusou: ${JSON.stringify(body)}`);
  let job;
  for (let i = 0; i < 100; i++) {
    job = (await get(`/api/job?id=${body.id}`)).body;
    if (job.status !== 'running' && job.status !== 'queued') break;
    await sleep(80);
  }
  return job;
}

const scanFiles = async () => (await get('/api/scan')).body.files.map((f) => f.path);

test.before(async () => {
  await new Promise((r) => mock.listen(3492, '127.0.0.1', r));

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restyle-e2e-'));
  sourceDir = path.join(tmp, 'src');
  fs.mkdirSync(sourceDir, { recursive: true });
  for (const n of ['Rocco', 'Gata']) fs.writeFileSync(path.join(sourceDir, `${n}.png`), PNG_1PX);

  fs.copyFileSync(path.join(ROOT, 'art-direction.md'), path.join(tmp, 'art-direction.md'));
  fs.copyFileSync(path.join(ROOT, 'art-direction.yaml'), path.join(tmp, 'art-direction.yaml'));
  fs.cpSync(path.join(ROOT, 'lib'), path.join(tmp, 'lib'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(tmp, 'server.mjs'));

  fs.writeFileSync(
    path.join(tmp, 'config.json'),
    JSON.stringify({ geminiKey: 'fake-key', sourceDir, outputDir: path.join(tmp, 'out') }),
  );

  server = spawn(process.execPath, ['server.mjs'], {
    cwd: tmp,
    env: {
      ...process.env,
      PORT: String(PORT),
      GEMINI_BASE: 'http://127.0.0.1:3492',
      OPENAI_BASE: 'http://127.0.0.1:3492',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => (stderr += String(d)));

  await waitFor(`${BASE}/api/styles`);
});

test.after(() => {
  server?.kill();
  mock.close();
});

// ------------------------------------------------------------ rotas

test('GET /api/styles devolve A, B e C com metadados', async () => {
  const { body } = await get('/api/styles');
  assert.deepEqual(body.styles.map((s) => s.id), ['A', 'B', 'C']);
  const c = body.styles.find((s) => s.id === 'C');
  assert.equal(c.aspect, '16:9');
  assert.equal(c.negatives, 0, 'C não deve ter negativas próprias');
});

test('POST /api/preview monta o prompt sem chave e sem rede', async () => {
  const before = seen.length;
  const { status, body } = await post('/api/preview', { style: 'A', path: path.join(sourceDir, 'Rocco.png') });
  assert.equal(status, 200);
  assert.match(body.prompt, /Change the rendering language, not the character design/);
  assert.ok(body.negatives.some((n) => /watermark/.test(n)), 'negativa de texto deve entrar em A');
  assert.equal(seen.length, before, 'preview não pode chamar o provider');
});

test('POST /api/preview rejeita estilo inexistente com 400', async () => {
  const { status, body } = await post('/api/preview', { style: 'Z' });
  assert.equal(status, 400);
  assert.match(body.error, /não existe no card/);
});

test('/api/compile foi removido: 404, não 400', async () => {
  // A rota 404 responde texto puro, não JSON — por isso o fetch direto.
  const res = await fetch(`${BASE}/api/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'x' }),
  });
  assert.equal(res.status, 404);
});

test('/api/image bloqueia path traversal com 403', async () => {
  const res = await fetch(`${BASE}/api/image?p=${encodeURIComponent('C:/Windows/win.ini')}`);
  assert.equal(res.status, 403);
});

test('JSON malformado retorna 400, não 500', async () => {
  const { status } = await post('/api/preview', {}, '{nao e json');
  assert.equal(status, 400);
});

test('BOM no body é aceito (PowerShell sempre manda)', async () => {
  const { status } = await post('/api/preview', null, '\uFEFF{"style":"A"}');
  assert.equal(status, 200);
});

test('GET /api/scan lista as imagens', async () => {
  const { body } = await get('/api/scan');
  assert.equal(body.count, 2);
  assert.ok(body.files.every((f) => f.url.startsWith('/api/image?p=')));
});

// ------------------------------------------------------------ shape do provider

test('primeira input é sempre a ORIGINAL, e as refs vêm depois', async () => {
  // Sem refs no tmp, então deve entrar exatamente 1 imagem.
  seen.length = 0;
  await runRender({ files: [path.join(sourceDir, 'Rocco.png')], style: 'A', name: 'ordem' });

  assert.equal(seen.length, 1);
  const call = seen[0];
  assert.equal(call.kind, 'gemini');
  assert.equal(call.parts.images, 1, 'sem refs, só a original');
  assert.ok(call.parts.hasText, 'prompt precisa ir junto');
  assert.equal(call.aspect, '3:4', 'aspect do estilo A');
  assert.deepEqual(call.modalities, ['IMAGE'], 'só imagem, nunca texto');
});

test('provider recebe o prompt do card, com identity e preservation', async () => {
  seen.length = 0;
  await runRender({ files: [path.join(sourceDir, 'Gata.png')], style: 'A', force: true, name: 'promptcheck' });
  const p = seen[0].prompt;
  assert.match(p, /KARTACLYSMA VISUAL DNA/, 'identidade presente');
  assert.match(p, /Change the rendering language, not the character design/);
  assert.match(p, /Subject: Gata/);
});

// ------------------------------------------------------------ jobs

test('job gera as duas imagens com o estilo pedido', async () => {
  // `force`: os testes de ordem de input acima já geraram A para estas imagens,
  // então sem force este lote seria pulado — e o teste mediria a idempotência,
  // que já tem caso próprio.
  const job = await runRender({ files: await scanFiles(), style: 'A', force: true, name: 'loteA' });
  assert.equal(job.status, 'done');
  assert.equal(job.stats.done, 2);
  assert.equal(job.stats.error, 0);
  for (const item of job.items) {
    assert.equal(item.state, 'done');
    assert.equal(item.outputs.length, 1, 'variants=1 por padrão');
    assert.ok(fs.existsSync(item.output));
  }
});

test('mesma imagem + mesmo estilo é pulado (idempotência)', async () => {
  const job = await runRender({ files: await scanFiles(), style: 'A', name: 'loteA2' });
  assert.equal(job.stats.skipped, 2);
  assert.equal(job.stats.done, 0);
});

/** Regressão do bug que motivou `style` entrar na chave do manifesto. */
test('estilo C não colide com A: gera de novo em vez de pular', async () => {
  const job = await runRender({ files: await scanFiles(), style: 'C', name: 'loteC' });
  assert.equal(job.stats.skipped, 0, 'C não pode ser confundido com A');
  assert.equal(job.stats.done, 2);
  for (const item of job.items) assert.match(item.prompt, /visible background text/);
});

test('force ignora o manifesto e re-gera', async () => {
  const job = await runRender({ files: await scanFiles(), style: 'A', force: true, name: 'loteF' });
  assert.equal(job.stats.done, 2);
  assert.equal(job.stats.skipped, 0);
});

test('variantes geram N arquivos distintos por imagem', async () => {
  const files = [(await scanFiles())[0]];
  const job = await runRender({ files, style: 'B', variants: 3, name: 'loteV' });
  const item = job.items[0];
  assert.equal(item.outputs.length, 3);
  assert.equal(new Set(item.outputs.map((o) => o.path)).size, 3, 'caminhos distintos');
  for (const o of item.outputs) assert.ok(fs.existsSync(o.path));
});

test('render sem chave do provider dá 400 antes de criar job', async () => {
  const { status, body } = await post('/api/render', {
    files: await scanFiles(),
    style: 'A',
    provider: 'openai',
  });
  assert.equal(status, 400);
  assert.match(body.error, /openai/);
  assert.match(body.error, /não configurada/);
});

test('render com estilo inexistente dá 400', async () => {
  const { status, body } = await post('/api/render', { files: await scanFiles(), style: 'Q' });
  assert.equal(status, 400);
  assert.match(body.error, /não existe no card/);
});

// ------------------------------------------------------------ settings

test('chave nunca volta no GET, e string vazia mantém a atual', async () => {
  await post('/api/settings', { geminiKey: 'AIzaTESTKEY123' });
  let s = (await get('/api/settings')).body;
  assert.equal(s.geminiKeySet, true);
  assert.equal(s.geminiKey, undefined, 'a chave não pode ser exposta no GET');

  await post('/api/settings', { geminiKey: '' });
  s = (await get('/api/settings')).body;
  assert.equal(s.geminiKeySet, true, 'vazio deve manter a chave');

  await post('/api/settings', { clearGeminiKey: true });
  s = (await get('/api/settings')).body;
  assert.equal(s.geminiKeySet, false, 'clear deve apagar');
});

test('nenhum server stack trace durante a suíte', () => {
  assert.ok(!/Unhandled|throw er|at Server/.test(stderr), `stderr inesperado:\n${stderr}`);
});

// ------------------------------------------------------------ card

test('card real não embute segredo e carrega', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'art-direction.yaml'), 'utf8');
  assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(raw), 'nenhuma chave OpenAI no card');
  assert.ok(!/AIza[0-9A-Za-z_-]{20,}/.test(raw), 'nenhuma chave Gemini no card');
  assert.ok(loadArtDir(ROOT).card);
});