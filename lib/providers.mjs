/**
 * Camada de provider de IMAGEM. Só imagem — não há chamada de texto em lugar
 * nenhum do pipeline, o que é decisão de projeto: a direção de arte vive no
 * art-direction.yaml e vai pro modelo sem tradução no meio.
 *
 * Consequência boa: a frase de identidade chega byte a byte, sempre. Não existe
 * LLM no meio para parafrasear, para inventar hex, ou para diluir a regra de
 * preservação. O que você escreveu é o que o modelo lê.
 */

import fs from 'node:fs';
import path from 'node:path';

const ASPECTS = {
  '1:1': 1,
  '3:4': 3 / 4,
  '4:3': 4 / 3,
  '2:3': 2 / 3,
  '3:2': 3 / 2,
  '9:16': 9 / 16,
  '16:9': 16 / 9,
};

/** gpt-image aceita resolução arbitrária: múltiplo de 16, ratio 1:3..3:1. */
export function sizeFor(aspect, maxPixels = 2160) {
  const ratio = ASPECTS[aspect] ?? 3 / 4;
  let h = Math.round(maxPixels / 16) * 16;
  let w = Math.round((maxPixels * ratio) / 16) * 16;
  w = Math.min(Math.max(w, 16), Math.round((h * 3) / 16) * 16);
  return `${w}x${h}`;
}

/** Gemini 2.x pede resolução por palavra-chave, não por pixel. */
function geminiResolution(aspect) {
  if (aspect === '1:1') return '1K';
  if (aspect === '16:9' || aspect === '3:2' || aspect === '4:3') return '2K';
  return '1K';
}

// ------------------------------------------------------------ montagem

/**
 * Monta o prompt a partir do card. Ordem é intencional:
 *
 *   1. identity_universe  — a assinatura do universo, primeiro, sempre igual
 *   2. traits do estilo   — o que muda entre A / B / C
 *   3. preservation       — a regra de não-trocar-o-personagem, ANTES do negates,
 *                           porque quem vem depois não deve conseguir apagar
 *   4. ratio textura      — o número de §4, que é instrução de intensidade
 *   5. accent do personagem, se o nome casar no roster
 *   6. subject            — a imagem original já é o assunto; só dá o nome
 *   7. negativos          — por último, com o menor peso possível
 *
 * `PRESERVAÇÃO` nunca sai, em nenhum estilo, mesmo que o card a omita: é a
 * única frase que impede o modelo de redesenhar o personagem em vez de
 * re-renderizá-lo. Falhar fechada aqui é intencional.
 */
const FALLBACK_PRESERVATION = [
  'Preserve the subject original identity, facial features, silhouette, clothing and distinctive visual motifs.',
  'Change the rendering language, not the design.',
];

export function buildPrompt({ card, style = 'A', subjectName, extra = [] }) {
  const s = card?.styles?.[style];
  if (!s) {
    throw new Error(`estilo "${style}" não existe no card. Disponíveis: ${Object.keys(card?.styles ?? {}).join(', ')}`);
  }

  const parts = [];
  const identity = card?.identity_universe;
  if (identity) parts.push(identity);

  if (s.traits?.length) parts.push(`Style traits: ${s.traits.join(', ')}.`);

  const preservation = card?.preservation?.length ? card.preservation : FALLBACK_PRESERVATION;
  parts.push(preservation.join(' '));

  if (typeof s.clean_distressed === 'number') {
    const dist = Math.round(s.clean_distressed * 100);
    parts.push(
      `Texture: approximately ${100 - dist}% clean / ${dist}% distressed print, ink and paper wear. Must not reduce subject legibility.`,
    );
  }

  const accent = card?.roster?.[subjectName];
  if (accent) {
    parts.push(
      `This subject carries its own secondary accent colour (${accent}), which must not override the shared universe palette.`,
    );
  }

  if (card?.palette_rule) parts.push(card.palette_rule);
  if (card?.small_scale_rule && style !== 'C') parts.push(card.small_scale_rule);
  if (subjectName) parts.push(`Subject: ${subjectName}.`);

  for (const x of extra) if (x) parts.push(String(x));

  const negatives = [...(card?.negative_common ?? []), ...(card?.negative_by_style?.[style] ?? [])];
  if (negatives.length) parts.push(`Avoid: ${negatives.join('; ')}.`);

  return { prompt: parts.filter(Boolean).join(' '), negatives, styleName: s.name ?? style, aspect: s.aspect ?? '3:4' };
}

// ------------------------------------------------------------ providers

const mimeFor = (p) => {
  const ext = path.extname(p).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
};

async function readJson(res) {
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`resposta não-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }
}

/**
 * openai — POST /v1/images/edits (multipart).
 * A original é SEMPRE a primeira input; inverter isso faz o modelo reescrever
 * a silhueta em vez de re-renderizá-la.
 */
async function openaiRender({ key, sourcePath, refs, prompt, model, quality, aspect, maxPixels, signal }) {
  const form = new FormData();
  form.append('model', model);
  form.append('image[]', new Blob([fs.readFileSync(sourcePath)]), path.basename(sourcePath));
  for (const ref of refs) form.append('image[]', new Blob([fs.readFileSync(ref)]), path.basename(ref));
  form.append('prompt', prompt);
  form.append('size', sizeFor(aspect, maxPixels));
  form.append('quality', quality);
  form.append('output_format', 'png');
  // NÃO enviar input_fidelity: no gpt-image a fidelidade de entrada já é alta.

  const base = process.env.OPENAI_BASE || 'https://api.openai.com';
  const res = await fetch(base + '/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal,
  });
  const json = await readJson(res);
  if (!res.ok) throw new Error(`openai ${res.status}: ${json?.error?.message ?? 'erro'}`);

  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error('openai: resposta sem b64_json');
  return { buffer: Buffer.from(b64, 'base64') };
}

/**
 * gemini — generateContent com partes inline.
 * A documentação do Google recomenda no máximo 3 imagens de entrada nos modelos
 * Flash, então o default de refs é baixo de propósito: mandar 5 e torcer só
 * piora o resultado.
 */
async function geminiRender({ key, sourcePath, refs, prompt, model, aspect, signal }) {
  const parts = [
    { inline_data: { mime_type: mimeFor(sourcePath), data: fs.readFileSync(sourcePath).toString('base64') } },
  ];
  for (const ref of refs) {
    parts.push({ inline_data: { mime_type: mimeFor(ref), data: fs.readFileSync(ref).toString('base64') } });
  }
  parts.push({ text: prompt });

  const base = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com';
  const res = await fetch(
    base +
      '/v1beta/models/' +
      encodeURIComponent(model) +
      ':generateContent?key=' +
      encodeURIComponent(key),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: aspect, imageSize: geminiResolution(aspect) },
        },
      }),
      signal,
    },
  );

  const json = await readJson(res);
  if (!res.ok) throw new Error(`gemini ${res.status}: ${json?.error?.message ?? 'erro'}`);

  const partsOut = json?.candidates?.[0]?.content?.parts ?? [];
  const b64 = partsOut.find((p) => p.inlineData?.data || p.inline_data?.data)?.inlineData?.data
    ?? partsOut.find((p) => p.inline_data?.data)?.inline_data?.data;
  if (!b64) throw new Error('gemini: resposta sem parte de imagem');
  return { buffer: Buffer.from(b64, 'base64') };
}

export const PROVIDERS = {
  openai: { render: openaiRender, defaultModel: 'gpt-image-2', draftModel: 'gpt-image-1-mini' },
  gemini: { render: geminiRender, defaultModel: 'gemini-3.1-flash-image', draftModel: 'gemini-3.1-flash-lite-image' },
};

export async function renderImage({ provider = 'gemini', key, sourcePath, refs = [], prompt, model, quality, aspect, maxPixels, signal }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`provider desconhecido: ${provider}. Disponíveis: ${Object.keys(PROVIDERS).join(', ')}`);
  if (!key) throw new Error(`chave de "${provider}" não configurada`);

  const chosen = model || p.defaultModel;
  const args = { key, sourcePath, refs, prompt, model: chosen, aspect, signal };
  if (provider === 'openai') Object.assign(args, { quality, maxPixels });

  return p.render(args);
}
