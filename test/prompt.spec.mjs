import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, sizeFor, PROVIDERS } from '../lib/providers.mjs';

// Card mínimo espelhando a estrutura do art-direction.yaml real.
const card = {
  identity_universe: 'BLACK BLOOM is a twisted gothic seed-guardian myth printed as loud indie comic art.',
  palette_rule: 'Shared palette is enforced across every subject; do not recolour the cast per image.',
  small_scale_rule: 'At small scale, keep the subject dominant and background simple.',
  styles: {
    A: {
      name: 'STYLE A — classic hero splash',
      aspect: '3:4',
      clean_distressed: 0.15,
      traits: ['classic comic panel', 'clean outlines', 'single ground shadow', 'NO text or speech bubbles'],
    },
    C: {
      name: 'STYLE C — propaganda collage',
      aspect: '3:4',
      clean_distressed: 0.85,
      traits: ['dense textured background', 'overlapping ink layers', 'visible text'],
    },
  },
  preservation: [
    'Preserve the subject original identity, facial features, silhouette and clothing.',
    'Change the rendering language, not the design.',
  ],
  negative_common: ['photorealism', '3d render'],
  negative_by_style: {
    A: ['speech bubbles', 'text'],
    C: [],
  },
  roster: { Rocco: 'orange' },
};

// ------------------------------------------------------------ montagem

test('identidade entra primeiro e literal, sem paraphrase', () => {
  const { prompt } = buildPrompt({ card, style: 'A' });
  assert.ok(prompt.startsWith(card.identity_universe), 'prompt deve começar pela identidade');
  assert.ok(prompt.includes(card.identity_universe), 'identidade deve estar byte a byte');
});

test('preservation nunca some, em nenhum estilo', () => {
  for (const style of ['A', 'C']) {
    const { prompt } = buildPrompt({ card, style });
    assert.ok(prompt.includes('Change the rendering language, not the design.'), `preservation ausente em ${style}`);
  }
});

test('preservation aparece ANTES dos negativos', () => {
  const { prompt } = buildPrompt({ card, style: 'A' });
  assert.ok(prompt.indexOf('Change the rendering') < prompt.indexOf('Avoid:'), 'preservation precisa preceder os negativos');
});

test('negativas são específicas por estilo', () => {
  const a = buildPrompt({ card, style: 'A' });
  const c = buildPrompt({ card, style: 'C' });

  assert.deepEqual(a.negatives, ['photorealism', '3d render', 'speech bubbles', 'text']);
  // C não tem negativas próprias, e precisa continuar sendo um array — não undefined.
  assert.deepEqual(c.negatives, ['photorealism', '3d render']);
  assert.ok(!c.prompt.includes('speech bubbles'), 'negativa do estilo A não pode vazar para C');
});

test('razão clean/distressed segue §4 e inverte por estilo', () => {
  const a = buildPrompt({ card, style: 'A' });
  const c = buildPrompt({ card, style: 'C' });
  assert.match(a.prompt, /85% clean \/ 15% distressed/);
  assert.match(c.prompt, /15% clean \/ 85% distressed/);
});

test('accent do roster entra só quando o nome casa', () => {
  const withName = buildPrompt({ card, style: 'A', subjectName: 'Rocco' });
  const without = buildPrompt({ card, style: 'A', subjectName: 'Ninguem' });
  assert.match(withName.prompt, /orange/);
  assert.ok(!without.prompt.includes('orange'));
});

test('regra de escala pequena é omitida no estilo C', () => {
  assert.ok(!buildPrompt({ card, style: 'C' }).prompt.includes('background simple'));
  assert.ok(buildPrompt({ card, style: 'A' }).prompt.includes('background simple'));
});

test('estilo inexistente falha com erro claro', () => {
  assert.throws(() => buildPrompt({ card, style: 'Z' }), /não existe no card/);
});

test('preservation ausente no card cai no fallback, não fica vazio', () => {
  const semPreservacao = { ...card, preservation: undefined };
  const { prompt } = buildPrompt({ card: semPreservacao, style: 'A' });
  assert.match(prompt, /Preserve the subject original identity/);
});

test('card sem styles não quebra o módulo', () => {
  assert.throws(() => buildPrompt({ card: {}, style: 'A' }), /não existe no card/);
});

// ------------------------------------------------------------ tamanho

test('sizeFor respeita múltiplo de 16 e ratio', () => {
  assert.equal(sizeFor('1:1', 2160), '2160x2160');
  const [w, h] = sizeFor('3:4', 2160).split('x').map(Number);
  assert.equal(w % 16, 0);
  assert.equal(h % 16, 0);
  assert.ok(w / h > 0.7 && w / h < 0.8, `ratio 3:4 esperado, veio ${w / h}`);
});

test('sizeFor não estoura o ratio 3:1', () => {
  for (const a of ['1:1', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9']) {
    const [w, h] = sizeFor(a, 2160).split('x').map(Number);
    assert.ok(w / h >= 1 / 3 - 1e-9 && w / h <= 3 + 1e-9, `${a} saiu fora de 1:3..3:1 (${w / h})`);
  }
});

test('sizeFor usa 3:4 para aspect desconhecido', () => {
  const [w, h] = sizeFor('banana', 2160).split('x').map(Number);
  assert.ok(w / h > 0.7 && w / h < 0.8);
});

// ------------------------------------------------------------ providers

test('ambos os providers estão registrados com defaultModel', () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['gemini', 'openai']);
  for (const [name, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.defaultModel, `${name} sem defaultModel`);
    assert.ok(p.draftModel, `${name} sem draftModel`);
    assert.equal(typeof p.render, 'function');
  }
});

test('provider desconhecido e chave ausente dão erro explícito', async () => {
  const { renderImage } = await import('../lib/providers.mjs');
  await assert.rejects(() => renderImage({ provider: 'nope', key: 'x' }), /provider desconhecido/);
  await assert.rejects(() => renderImage({ provider: 'gemini', key: '' }), /não configurada/);
});