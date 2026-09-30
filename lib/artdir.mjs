import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parser de um subconjunto de YAML — só o que este projeto usa:
 * mapas aninhados por indentação de 2 espaços, listas com `-`, escalares,
 * arrays inline `[a, b]`, comentários e strings entre aspas.
 * Sem dependências externas. Não tentei cobrir o YAML inteiro de propósito:
 * o formato do card é nosso, então recursão infinita não é preciso.
 */
export function parseYaml(src) {
  const lines = src
    .split(/\r?\n/)
    .map((l) => l.replace(/\t/g, '  '))
    .filter((l) => l.trim() && !/^\s*#/.test(l));

  let i = 0;

  const scalar = (raw) => {
    const s = raw.trim();
    if (s === '' || s === '~' || s === 'null') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (s.startsWith('"') && s.endsWith('"') && s.length > 1) return JSON.parse(s);
    if (s.startsWith("'") && s.endsWith("'") && s.length > 1) return s.slice(1, -1).replace(/''/g, "'");
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1).trim();
      return inner ? splitTopLevel(inner).map((x) => scalar(x)) : [];
    }
    if (s.startsWith('{') && s.endsWith('}')) return flowMap(s.slice(1, -1));
    // Chave ou colchete desbalanceado: erro explícito, não string silenciosa.
    if (/^[{[]/.test(s)) throw new Error(`escalar malformado (delimitador desbalanceado): ${s.slice(0, 80)}`);
    return s;
  };

  /** Flow map de um nível: { a: 1, b: "x" }. Aninhado não é suportado. */
  const flowMap = (inner) => {
    const out = {};
    if (!inner.trim()) return out;
    for (const part of splitTopLevel(inner)) {
      const m = part.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*([\s\S]+?)\s*$/);
      if (!m) throw new Error(`flow map malformado: {${part}}`);
      out[m[1]] = scalar(m[2]);
    }
    return out;
  };

  /** Divide por vírgulas respeitando aspas e colchetes/chaves aninhados. */
  const splitTopLevel = (s) => {
    const parts = [];
    let depth = 0;
    let quote = null;
    let buf = '';
    for (const ch of s) {
      if (quote) {
        buf += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        buf += ch;
        continue;
      }
      if (ch === '[' || ch === '{') depth++;
      if (ch === ']' || ch === '}') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(buf);
        buf = '';
        continue;
      }
      buf += ch;
    }
    if (buf.trim()) parts.push(buf);
    return parts.map((p) => p.trim()).filter((p) => p !== '');
  };

  const inlineComment = (s) => {
    // Só remove comentário fora de aspas.
    let q = null;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === '#' && (k === 0 || /\s/.test(s[k - 1]))) return s.slice(0, k);
    }
    return s;
  };

  function block(indent) {
    // Decide entre mapa e lista olhando a primeira linha do bloco.
    const start = i;
    const isList = lines[i].slice(indent).startsWith('- ');

    if (isList) {
      const out = [];
      while (i < lines.length) {
        const line = lines[i];
        const cur = line.length - line.trimStart().length;
        if (cur < indent || !line.slice(cur).startsWith('- ')) break;
        out.push(scalar(inlineComment(line.slice(cur + 2))));
        i++;
      }
      return out;
    }

    const out = {};
    while (i < lines.length) {
      const line = lines[i];
      const cur = line.length - line.trimStart().length;
      if (cur < indent) break;
      const body = inlineComment(line.slice(cur));
      const m = body.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!m) {
        i++;
        continue;
      }
      const [, key, rest] = m;
      if (rest.trim() !== '') {
        out[key] = scalar(rest);
        i++;
      } else {
        i++;
        const childIndent = i < lines.length ? lines[i].length - lines[i].trimStart().length : -1;
        out[key] = childIndent > cur ? block(childIndent) : null;
      }
    }
    if (i === start) i++;
    return out;
  }

  if (!lines.length) return {};
  return block(lines[0].length - lines[0].trimStart().length);
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

export function loadArtDir(root) {
  const mdPath = path.join(root, 'art-direction.md');
  const yamlPath = path.join(root, 'art-direction.yaml');

  const mdRaw = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
  const yamlRaw = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf8') : '';

  let card = {};
  let cardError = null;
  try {
    card = parseYaml(yamlRaw);
  } catch (e) {
    cardError = e.message;
  }

  // Hash do CONTEÚDO: mudar só um comentário não invalida o manifesto.
  const hash = sha1(Buffer.from(mdRaw + ' ' + normalizeForHash(card), 'utf8'));

  return {
    md: mdRaw,
    mdPath,
    yamlPath,
    card,
    cardError,
    hash,
    refs: listRefs(root),
  };
}

/** Serialização estável para que a ordem das chaves não mude o hash. */
export function normalizeForHash(value) {
  if (Array.isArray(value)) return '[' + value.map(normalizeForHash).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => k + ':' + normalizeForHash(value[k])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

function listRefs(root) {
  const dir = path.join(root, 'refs');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

export function fileHash(absPath) {
  return fs.existsSync(absPath) ? sha1(fs.readFileSync(absPath)) : null;
}
