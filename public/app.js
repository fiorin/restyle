const $ = (id) => document.getElementById(id);
const api = async (path, opts) => {
  const res = await fetch(path, {
    ...opts,
    headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
};

const state = { files: [], selected: new Set(), active: null, settings: null, styles: [], poller: null };

// ---------------------------------------------------------------- boot

init();

async function init() {
  state.settings = await api('/api/settings');
  $('sourceDir').value = state.settings.sourceDir || '';
  $('provider').value = state.settings.provider || 'gemini';
  $('variants').value = state.settings.variants ?? 1;
  $('draft').checked = false;
  $('jobName').value = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

  fillSettingsForm(state.settings);
  await Promise.all([loadArtDirHash(), loadStyles()]);
  if (state.settings.sourceDir) scan();
}

async function loadArtDirHash() {
  const a = await api('/api/artdir');
  $('hash').textContent = 'art ' + a.hash.slice(0, 8);
  $('hash').title = `art-direction ${a.mdPath}\nyaml ${a.yamlPath}\nhash ${a.hash}`;
}

/** O seletor de estilo vem do card, nunca de uma lista fixa na UI. */
async function loadStyles() {
  const res = await api('/api/styles');
  state.styles = res.styles;
  const sel = $('style');
  sel.textContent = '';
  if (!res.styles.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = res.error ? 'card inválido' : 'sem estilos';
    sel.append(o);
    sel.disabled = true;
    const hint = $('styleHint');
    hint.textContent = res.error ? 'Erro no art-direction.yaml: ' + res.error : 'O card não define styles.';
    hint.classList.remove('hidden');
    return;
  }
  for (const s of res.styles) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.id} · ${s.name}`;
    sel.append(o);
  }
  renderStyleHint();
}

function renderStyleHint() {
  const s = state.styles.find((x) => x.id === $('style').value);
  const hint = $('styleHint');
  if (!s) return hint.classList.add('hidden');
  const dist = s.clean_distressed != null ? Math.round(s.clean_distressed * 100) : null;
  hint.textContent =
    `${s.name} · ${s.aspect}` +
    (dist != null ? ` · ${100 - dist}% limpo / ${dist}% desgastado` : '') +
    ` · ${s.negatives} negativa(s) específica(s)` +
    (s.traits.length ? ` · ${s.traits.slice(0, 3).join(', ')}${s.traits.length > 3 ? '…' : ''}` : '');
  hint.classList.remove('hidden');
}

/** Trocar o estilo re-monta a comparação, porque o prompt muda junto. */
$('style').onchange = () => {
  renderStyleHint();
  if (state.active) showCompare(state.active);
};

// ---------------------------------------------------------------- settings

function fillSettingsForm(c) {
  $('setSource').value = c.sourceDir || '';
  $('setOutput').value = c.outputDir || '';
  $('setProvider').value = c.provider || 'gemini';
  $('setGeminiModel').value = c.geminiModel || '';
  $('setRenderModel').value = c.renderModel || '';
  $('setQuality').value = c.quality || '';
  $('setMaxPixels').value = c.maxPixels ?? 2160;
  $('setVariants').value = c.variants ?? 1;
  $('setAnchor').checked = !!c.useStyleAnchor;
  $('setRefs').checked = !!c.useRefs;
  $('setToken').value = '';
  $('setGeminiKey').value = '';
  const keys = [];
  if (c.geminiKeySet) keys.push(`Gemini ok (final ${c.geminiKeyHint})`);
  if (c.tokenSet) keys.push(`OpenAI ok (final ${c.tokenHint})`);
  $('settingsHint').textContent = keys.length ? keys.join(' · ') : 'Nenhuma chave configurada';
}

$('btn-settings').onclick = () => $('dlg-settings').showModal();
$('settingsClose').onclick = () => $('dlg-settings').close();

$('settingsSave').onclick = async () => {
  try {
    state.settings = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        provider: $('setProvider').value,
        geminiKey: $('setGeminiKey').value,
        token: $('setToken').value,
        sourceDir: $('setSource').value.trim(),
        outputDir: $('setOutput').value.trim(),
        geminiModel: $('setGeminiModel').value.trim(),
        renderModel: $('setRenderModel').value.trim(),
        quality: $('setQuality').value.trim(),
        maxPixels: Number($('setMaxPixels').value),
        variants: Number($('setVariants').value),
        useStyleAnchor: $('setAnchor').checked,
        useRefs: $('setRefs').checked,
      }),
    });
    fillSettingsForm(state.settings);
    $('provider').value = state.settings.provider || 'gemini';
    $('variants').value = state.settings.variants ?? 1;
    $('dlg-settings').close();
    $('sourceDir').value = state.settings.sourceDir || '';
    if (state.settings.sourceDir) scan();
  } catch (e) {
    $('settingsHint').textContent = 'Erro: ' + e.message;
  }
};

// ---------------------------------------------------------------- artdir

$('btn-artdir').onclick = async () => {
  const a = await api('/api/artdir');
  $('artdirPaths').textContent = `${a.mdPath} · ${a.yamlPath}${a.cardError ? ' · ERRO: ' + a.cardError : ''}`;
  $('artdirMd').textContent = a.md;
  $('artdirYaml').textContent = JSON.stringify(a.card, null, 2);
  $('dlg-artdir').showModal();
};
$('artdirClose').onclick = () => $('dlg-artdir').close();
$('artdirReload').onclick = async () => {
  await api('/api/artdir/reload', { method: 'POST' });
  await Promise.all([loadArtDirHash(), loadStyles()]);
  $('artdirReload').textContent = 'Recarregado';
  setTimeout(() => ($('artdirReload').textContent = 'Recarregar do disco'), 1500);
};

// ---------------------------------------------------------------- scan

$('btn-scan').onclick = scan;

async function scan() {
  const dir = $('sourceDir').value.trim();
  if (!dir) return;
  try {
    const res = await api('/api/scan?dir=' + encodeURIComponent(dir));
    state.files = res.files;
    state.selected = new Set(res.files.map((f) => f.path));
    renderList();
    $('btn-render').textContent = `Converter selecionadas (${res.count})`;
  } catch (e) {
    alert(e.message);
  }
}

function renderList() {
  const el = $('list');
  el.textContent = '';
  for (const f of state.files) {
    const row = document.createElement('div');
    row.className = 'item' + (state.active === f.path ? ' active' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(f.path);
    cb.onclick = (e) => {
      e.stopPropagation();
      cb.checked ? state.selected.add(f.path) : state.selected.delete(f.path);
      $('btn-render').textContent = `Converter selecionadas (${state.selected.size})`;
    };

    const img = document.createElement('img');
    img.src = f.url;
    img.loading = 'lazy';

    const meta = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = f.name;
    const sub = document.createElement('div');
    sub.className = 'meta' + (f.stale ? ' stale' : f.lastOutput ? ' has' : '');
    sub.textContent = f.stale
      ? 'direção de arte mudou'
      : f.lastOutput
        ? `gerado · ${f.lastStyle ?? '?'}`
        : 'novo';
    meta.append(name, sub);

    row.append(cb, img, meta);
    row.onclick = () => showCompare(f.path);
    el.append(row);
  }
}

async function showCompare(path) {
  state.active = path;
  renderList();
  const f = state.files.find((x) => x.path === path);
  const stage = $('stage');
  stage.textContent = '';

  const out = f.lastOutput ? `/api/image?p=${encodeURIComponent(f.lastOutput)}` : null;
  const outCap = out ? `Convertida${f.lastStyle ? ` (${f.lastStyle})` : ''}` : 'Convertida (ainda não gerada)';
  const grid = document.createElement('div');
  grid.className = 'compare';
  grid.append(figure('Origem', `/api/image?p=${encodeURIComponent(path)}`), figure(outCap, out));
  stage.append(grid);

  try {
    const built = await api('/api/preview', { method: 'POST', body: JSON.stringify({ path, style: $('style').value }) });
    const pre = document.createElement('pre');
    pre.className = 'prompt';
    pre.textContent =
      `estilo ${built.styleName} · aspect ${built.aspect}\n` +
      `negativas: ${built.negatives.join(' | ') || '(nenhuma)'}\n\n${built.prompt}`;
    stage.append(pre);
  } catch (e) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Falha ao montar o prompt: ' + e.message;
    stage.append(p);
  }
}

function figure(caption, src) {
  const fig = document.createElement('figure');
  const cap = document.createElement('figcaption');
  cap.textContent = caption;
  const img = document.createElement('img');
  if (src) img.src = src;
  else img.alt = 'sem imagem';
  fig.append(cap, img);
  return fig;
}

// ---------------------------------------------------------------- render

$('btn-render').onclick = async () => {
  const files = state.files.filter((f) => state.selected.has(f.path)).map((f) => f.path);
  if (!files.length) return alert('Nada selecionado.');
  if (!$('style').value) return alert('Nenhum estilo disponível no card.');
  try {
    const { id, name, count } = await api('/api/render', {
      method: 'POST',
      body: JSON.stringify({
        files,
        name: $('jobName').value.trim(),
        style: $('style').value,
        provider: $('provider').value,
        variants: Number($('variants').value) || 1,
        draft: $('draft').checked,
        force: $('force').checked,
      }),
    });
    $('jobbar').classList.remove('hidden');
    poll(id, name, count);
  } catch (e) {
    alert(e.message);
  }
};

$('jobCancel').onclick = () => {
  if (state.currentJob) api('/api/job/cancel', { method: 'POST', body: JSON.stringify({ id: state.currentJob }) });
};

async function poll(id, name, count) {
  state.currentJob = id;
  const tick = async () => {
    let job;
    try {
      job = await api('/api/job?id=' + id);
    } catch {
      return;
    }
    const finished = job.items.filter((i) => i.state !== 'pending' && i.state !== 'working').length;
    $('jobProgress').value = finished / count;
    const errs = job.items.filter((i) => i.state === 'error').length;
    $('jobText').textContent =
      `${job.status} · ${finished}/${count} · ${job.stats.done} ok, ${job.stats.skipped} pulados, ${errs} erro(s)`;

    if (job.status === 'running' || job.status === 'queued') {
      return setTimeout(tick, 1200);
    }
    state.currentJob = null;
    $('jobText').textContent = `${job.status} · ${job.stats.done} ok, ${job.stats.skipped} pulados, ${errs} erro(s) → ${job.outputDir}`;
    await scan();
    api('/api/open', { method: 'POST', body: JSON.stringify({ name }) }).catch(() => {});
    setTimeout(() => $('jobbar').classList.add('hidden'), 6000);
  };
  tick();
}
