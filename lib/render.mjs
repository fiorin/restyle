/**
 * Estágio único — conversão de estilo.
 *
 * Este arquivo é deliberadamente fino. Quem sabe falar com cada API é
 * `lib/providers.mjs`; aqui ficam só as garantias que valem para todo provider:
 *
 *   - a imagem ORIGINAL é sempre a primeira input, porque é ela que ancora a
 *     composição; inverter a ordem faz o modelo reescrever a silhueta em vez de
 *     re-renderizá-la;
 *   - referência inexistente é ignorada, não derruba o job inteiro;
 *   - fonte sumindo é erro explícito.
 */

import fs from 'node:fs';
import { renderImage as callProvider } from './providers.mjs';

export { sizeFor, buildPrompt, PROVIDERS, renderImage as renderWithProvider } from './providers.mjs';

export async function renderImage({ sourcePath, prompt, refs = [], provider = 'gemini', ...rest }) {
  if (!fs.existsSync(sourcePath)) throw new Error(`fonte não encontrada: ${sourcePath}`);

  const usable = refs.filter((r) => {
    if (!r || !fs.existsSync(r)) return false;
    return true;
  });

  return callProvider({ provider, sourcePath, refs: usable, prompt, ...rest });
}