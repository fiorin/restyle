/**
 * Manifesto — idempotência e histórico.
 *
 * Chave: hash(artDirHash + sourceHash + prompt + provider + model + quality +
 * aspect + style). Serve para três coisas: pular o que já foi gerado, re-rodar só
 * o que falhou, e dizer qual versão da direção de arte produziu qual imagem.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Manifest {
  constructor(workDir) {
    this.workDir = workDir;
    this.file = path.join(workDir, 'manifest.json');
    this.entries = new Map();
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
      for (const e of raw.entries ?? []) this.entries.set(e.key, e);
    } catch {
      /* manifesto ausente ou corrompido: recomeça limpo */
    }
  }

  save() {
    fs.mkdirSync(this.workDir, { recursive: true });
    const entries = [...this.entries.values()].sort((a, b) => a.key.localeCompare(b.key));
    fs.writeFileSync(this.file, JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2));
  }

  /**
   * Chave: hash(artDirHash + sourceHash + prompt + provider + model + quality + aspect + style).
   *
   * `style` entrou na chave depois de um bug real: sem ele, converter a mesma
   * imagem como STYLE A e como STYLE C produzia a mesma chave, e o segundo job
   * pulava o primeiro como "já gerado" — servindo a imagem do estilo errado sem
   * ninguém pedir.
   */
  static key({ artDirHash, sourceHash, prompt, provider, model, quality, aspect, style }) {
    return crypto
      .createHash('sha1')
      .update([artDirHash, sourceHash, prompt, provider, model, quality, aspect, style ?? '-'].join(' '))
      .digest('hex');
  }

  /** Entrada existente para a MESMA direção de arte e prompt. */
  get(key) {
    return this.entries.get(key);
  }

  /** Entrada para a mesma imagem, mas de uma direção de arte diferente. */
  findBySource(sourcePath) {
    return [...this.entries.values()].filter((e) => e.source === sourcePath);
  }

  put(entry) {
    this.entries.set(entry.key, entry);
    this.save();
    return entry;
  }

  update(key, patch) {
    const cur = this.entries.get(key);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.entries.set(key, next);
    this.save();
    return next;
  }
}
