import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Manifest } from '../lib/manifest.mjs';
import { loadArtDir } from '../lib/artdir.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'restyle-'));

const base = {
  artDirHash: 'art1',
  sourceHash: 'src1',
  prompt: 'p',
  provider: 'gemini',
  model: 'gemini-3.1-flash-image',
  quality: 'high',
  aspect: '3:4',
  style: 'A',
};

test('Manifest.key: mesma entrada -> mesma chave', () => {
  assert.equal(Manifest.key(base), Manifest.key({ ...base }));
});

test('Manifest.key: direção de arte diferente -> chave diferente', () => {
  assert.notEqual(Manifest.key(base), Manifest.key({ ...base, artDirHash: 'art2' }));
});

test('Manifest.key: prompt diferente -> chave diferente', () => {
  assert.notEqual(Manifest.key(base), Manifest.key({ ...base, prompt: 'p2' }));
});

test('Manifest.key: quality/aspect/model/provider mudam a chave', () => {
  for (const patch of [{ quality: 'low' }, { aspect: '1:1' }, { model: 'gpt-image-2' }, { provider: 'openai' }]) {
    assert.notEqual(Manifest.key(base), Manifest.key({ ...base, ...patch }), JSON.stringify(patch));
  }
});

/**
 * Regressão do bug de colisão A/C. Sem `style` na chave, converter a mesma imagem
 * nos dois estilos produzia a mesma chave e o segundo job era pulado como "já
 * gerado", servindo a imagem do estilo errado.
 */
test('Manifest.key: estilo A e estilo C não colidem', () => {
  assert.notEqual(Manifest.key({ ...base, style: 'A' }), Manifest.key({ ...base, style: 'C' }));
});

test('Manifest.key: estilo ausente não colide com "A" explícito', () => {
  assert.notEqual(Manifest.key({ ...base, style: undefined }), Manifest.key({ ...base, style: 'A' }));
});

test('Manifest: put/get persistem entre instâncias', () => {
  const dir = tmp();
  const key = Manifest.key(base);
  new Manifest(dir).put({ key, source: 'C:/a.png', output: 'C:/out/a.png', artDirHash: 'art1' });

  const reopened = new Manifest(dir);
  assert.equal(reopened.get(key).output, 'C:/out/a.png');
});

test('Manifest: update preserva campos anteriores', () => {
  const dir = tmp();
  const key = Manifest.key(base);
  const m = new Manifest(dir);
  m.put({ key, source: 'C:/a.png', prompt: 'p', artDirHash: 'art1' });
  const next = m.update(key, { qa: { overall: 0.42 } });

  assert.equal(next.prompt, 'p');
  assert.equal(next.qa.overall, 0.42);
  assert.equal(new Manifest(dir).get(key).qa.overall, 0.42);
});

test('Manifest: findBySource acha histórico de direções de arte diferentes', () => {
  const m = new Manifest(tmp());
  m.put({ key: 'k1', source: 'C:/a.png', artDirHash: 'art1' });
  m.put({ key: 'k2', source: 'C:/a.png', artDirHash: 'art2' });
  m.put({ key: 'k3', source: 'C:/b.png', artDirHash: 'art1' });

  const hist = m.findBySource('C:/a.png');
  assert.equal(hist.length, 2);
  assert.deepEqual(hist.map((h) => h.artDirHash).sort(), ['art1', 'art2']);
});

test('Manifest: manifesto corrompido não quebra o start', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{isto nao e json');
  assert.doesNotThrow(() => new Manifest(dir));
  assert.equal(new Manifest(dir).entries.size, 0);
});

test('Manifest: manifesto com BOM não quebra o start', () => {
  const dir = tmp();
  const key = Manifest.key(base);
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    '\uFEFF' + JSON.stringify({ entries: [{ key, source: 'C:/a.png', artDirHash: 'art1' }] }),
  );
  assert.equal(new Manifest(dir).get(key).artDirHash, 'art1');
});

test('loadArtDir: hash é estável e ignora mudança só de comentário', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'art-direction.md'), '# Estilo\n- traco: X\n');
  fs.writeFileSync(path.join(dir, 'art-direction.yaml'), 'version: 1\nstyle_identity: "F"\n');
  const a = loadArtDir(dir);

  assert.equal(a.hash, loadArtDir(dir).hash);

  fs.writeFileSync(path.join(dir, 'art-direction.md'), '# Estilo\n- traco: X\n');
  assert.equal(a.hash, loadArtDir(dir).hash, 'comentário novo não deve invalidar');

  fs.writeFileSync(path.join(dir, 'art-direction.md'), '# Estilo\n- traco: Y\n');
  assert.notEqual(a.hash, loadArtDir(dir).hash, 'mudança real deve invalidar');
});

test('loadArtDir: mudar só o card muda o hash', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'art-direction.md'), 'igual\n');
  fs.writeFileSync(path.join(dir, 'art-direction.yaml'), 'style_identity: "A"\n');
  const a = loadArtDir(dir);

  fs.writeFileSync(path.join(dir, 'art-direction.yaml'), 'style_identity: "A"\nnegative:\n  - "texto"\n');
  assert.notEqual(a.hash, loadArtDir(dir).hash);
});

test('loadArtDir: pasta sem nenhum dos dois arquivos não quebra', () => {
  const a = loadArtDir(tmp());
  assert.equal(a.cardError, null);
  assert.deepEqual(a.refs, []);
  assert.ok(a.hash.length > 0);
});

test('loadArtDir: style-anchor.png é identificado pelo nome', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'refs'));
  for (const f of ['style-anchor.png', 'ref-01.png', 'nota.txt']) {
    fs.writeFileSync(path.join(dir, 'refs', f), 'x');
  }
  const a = loadArtDir(dir);
  assert.equal(a.refs.length, 2, 'txt não deve entrar');
  assert.match(a.refs.find((r) => /style-anchor/i.test(r)), /style-anchor/);
});

test('loadArtDir: card real de KARTACLYSMA tem A, B e C', () => {
  const card = loadArtDir(path.join(import.meta.dirname, '..')).card;
  assert.ok(card, 'card não deve ser null');
  assert.deepEqual(Object.keys(card.styles).sort(), ['A', 'B', 'C']);
});

test('loadArtDir: estilo A proíbe texto e estilo C exige — e ambos estão registrados', () => {
  const card = loadArtDir(path.join(import.meta.dirname, '..')).card;
  assert.ok(/text/i.test(JSON.stringify(card.negative_by_style.A)), 'A precisa negativar texto');
  assert.match(JSON.stringify(card.styles.C.traits), /text/i, 'C precisa permitir texto');
  assert.ok(Array.isArray(card.negative_by_style.C), 'negative_by_style.C precisa ser array, não undefined');
});

test('loadArtDir: hex continua null — nunca foi inventado', () => {
  const card = loadArtDir(path.join(import.meta.dirname, '..')).card;
  assert.ok(card.palette, 'paleta precisa existir');
  for (const [role, v] of Object.entries(card.palette)) {
    assert.equal(v.hex, null, `${role} não deveria ter hex preenchido`);
  }
});
