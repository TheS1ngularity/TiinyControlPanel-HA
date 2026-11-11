/* Studio: music, image-to-3D and video, made on the device as background jobs that survive closing the tab. */
'use strict';

const StudioAPI = {
  start: (kind, body) => api(`/api/studio/${kind}`, {method: 'POST', body}),
  control: (jid, action) => api(`/api/jobs/${jid}/control`, {method: 'POST', body: {action}}),
  cancel: jid => api(`/api/jobs/${jid}/cancel`, {method: 'POST', body: {}}),
  jobs: async kind => (await api(`/api/jobs?kind=${kind}`)).jobs,
};
const STAGES_3D = [['Removing the background', 'Background'], ['Building the shape', 'Shape'], ['Simplifying the mesh', 'Simplify'],
  ['Painting the texture', 'Texture'], ['Exporting the model', 'Export']];

/* Audio file → WAV (16-bit PCM) at a given rate and channel count, at most maxSeconds long. */
async function toWav(blob, {rate = 48000, channels = 2, maxSeconds = 0} = {}) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ac = new Ctx();
  try {
    const buf = await ac.decodeAudioData(await blob.arrayBuffer());
    const secs = maxSeconds ? Math.min(buf.duration, maxSeconds) : buf.duration;
    const frames = Math.max(1, Math.ceil(secs * rate));
    const off = new OfflineAudioContext(channels, frames, rate);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    const chans = Array.from({length: channels}, (_, c) => out.getChannelData(Math.min(c, out.numberOfChannels - 1)));
    return {blob: encodeWav(chans, rate), seconds: buf.duration};
  } finally { ac.close(); }
}
function encodeWav(chans, rate) {
  const n = chans[0].length, nc = chans.length;
  const dv = new DataView(new ArrayBuffer(44 + n * nc * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * nc * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nc, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * nc * 2, true); dv.setUint16(32, nc * 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * nc * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { const v = Math.max(-1, Math.min(1, chans[c][i])); dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return new Blob([dv], {type: 'audio/wav'});
}

/* Progress for one kind of studio job; re-attaches to a job that is already running. */
function studioJob(kind, ctx, {onDone, stages} = {}) {
  const el = h('div', {class: 'stack-sm'});
  const ac = new AbortController();
  ctx.onCleanup(() => ac.abort());
  let job = null;
  let tick = null;
  const api_ = {el, get busy() { return !!job && job.status === 'running'; }, attach};
  function paint() {
    clear(el);
    if (!job) return;
    if (job.status === 'running') {
      const secs = Math.max(0, Date.now() / 1000 - job.created);
      const rows = [h('div', {class: 'row small'}, h('span', {class: 'spinner'}), h('strong', {class: 'spacer'}, job.message || 'Starting…'),
        h('span', {class: 'faint'}, fmtSecs(secs)))];
      if (stages) {
        const curIdx = stages.findIndex(([prefix]) => (job.message || '').startsWith(prefix));
        rows.push(h('div', {class: 'stages'}, stages.map(([, label], i) => h('span', {class: `stage ${i < curIdx ? 'done' : i === curIdx ? 'active' : ''}`}, i < curIdx ? icon('check') : null, label))));
      }
      rows.push(progressBar((job.progress ?? 0) * 100, {indeterminate: job.progress == null || job.progress === 0}));
      const ctrls = [];
      if (kind === 'model3d' && job.meta?.task_id) {
        ctrls.push(job.meta.paused
          ? btn('Resume', async () => { await StudioAPI.control(job.id, 'resume'); }, {small: true, icon: 'play'})
          : btn('Pause', async () => { await StudioAPI.control(job.id, 'pause'); }, {small: true, kind: 'ghost', icon: 'pause'}));
      }
      ctrls.push(btn('Cancel', async () => { await StudioAPI.cancel(job.id); }, {small: true, kind: 'ghost', icon: 'x'}));
      rows.push(h('div', {class: 'row wrap gap-sm'}, ctrls, h('span', {class: 'faint small'}, 'You can leave this page; it keeps going and lands in the Gallery.')));
      el.append(h('div', {class: 'job-box'}, rows));
    } else if (job.status === 'failed') {
      el.append(errorBlock(job.error || 'Something went wrong', {title: 'That didn’t work'}));
    } else if (job.status === 'cancelled') {
      el.append(h('p', {class: 'muted small'}, 'Cancelled.'));
    }
  }
  async function attach(j) {
    job = j;
    paint();
    clearInterval(tick);
    tick = setInterval(() => { if (!document.hidden && job?.status === 'running') paint(); }, 1000);
    ctx.onCleanup(() => clearInterval(tick));
    const final = await followJob(j.id, jj => { job = jj; paint(); }, {signal: ac.signal});
    clearInterval(tick);
    if (!final) return;
    job = final;
    paint();
    if (final.status === 'done') notify('Studio', `${final.title} is ready`);
    if (onDone) onDone(final);
  }
  StudioAPI.jobs(kind).then(list => { const r = list.find(j => j.status === 'running'); if (r && !job) attach(r); }).catch(() => {});
  return api_;
}

/* Image input used by 3D and video: a file, a gallery item, a paste or a drop. */
function imageInput({label = 'Image', hint, initialGalleryId, onChange} = {}) {
  let value = null;  // {gallery_id} | {file}, plus src (preview) and full (the full-size picture)
  const preview = h('div', {class: 'img-in-preview'});
  const fileInput = h('input', {type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true});
  const set = v => {
    value = v;
    if (onChange) setTimeout(() => onChange(v), 0);
    clear(preview);
    if (!v) { preview.append(h('div', {class: 'img-in-empty muted small'}, icon('image'), 'No image yet. Choose one, paste one or drop it here.')); return; }
    preview.append(h('img', {src: v.src, alt: 'chosen image'}), iconBtn('x', 'Remove', () => set(null)));
  };
  const setFile = f => { if (f && /^image\//.test(f.type)) set({file: f, src: URL.createObjectURL(f), name: f.name}); };
  fileInput.addEventListener('change', () => { setFile(fileInput.files[0]); fileInput.value = ''; });
  const el = h('div', {class: 'field'}, h('label', {}, label), preview,
    h('div', {class: 'row wrap gap-sm'}, btn('Choose a file', () => fileInput.click(), {small: true, icon: 'upload'}),
      btn('From the gallery', async () => { const it = await galleryPicker(); if (it) set({gallery_id: it.id, src: gUrl(it, 'thumb') || gUrl(it), full: gUrl(it), name: it.title}); }, {small: true, icon: 'grid', kind: 'ghost'})),
    hint ? h('small', {class: 'hint'}, hint) : null, fileInput);
  set(null);
  if (initialGalleryId) GalleryAPI.get(initialGalleryId).then(it => set({gallery_id: it.id, src: gUrl(it, 'thumb') || gUrl(it), full: gUrl(it), name: it.title})).catch(() => {});
  return {
    el, setFile,
    get value() { return value; },
    async spec(key) {
      if (!value) return null;
      if (value.gallery_id) return {[`${key}_gallery_id`]: value.gallery_id};
      const up = await uploadFile(value.file, null, value.name || 'image.png');
      return {[`${key}_file_id`]: up.id};
    },
  };
}

function recentStrip(kind, ctx, {title = 'Recent', limit = 6} = {}) {
  const el = h('div', {class: 'stack-sm'});
  async function load() {
    let list = [];
    try { list = (await GalleryAPI.list(kind)).slice(0, limit); } catch { return; }
    if (!ctx.alive()) return;
    clear(el);
    if (!list.length) return;
    el.append(h('div', {class: 'row'}, h('div', {class: 'section-title spacer'}, title), linkBtn('Open the gallery', `#/gallery?kind=${kind}`, {ic: 'grid'})),
      h('div', {class: 'g-grid small'}, list.map(it => galleryTile(it, () => galleryViewer(it, {list, onChange: load})))));
  }
  ctx.on('gallery', load);
  load();
  return {el, load};
}

function noModelState(kind, what) {
  return emptyState(GKIND[kind === 'model3d' ? 'model3d' : kind === 'music' ? 'audio' : kind]?.ic || 'box', `No ${what} model on your Tiiny`,
    `Download one from the model store first. Long renders run on the device and the results land in the Gallery.`,
    h('a', {class: 'btn primary sm', href: '#/models', onclick: () => sessionStorage.setItem('tiiny.modelsTab', 'store')}, icon('download'), 'Open the model store'));
}

function viewStudio(root, ctx) {
  const tabs = [['music', 'Music', studioMusic], ['3d', '3D', studio3d], ['video', 'Video', studioVideo]];
  let tab = ctx.params[0] || sessionStorage.getItem('tiiny.studioTab') || 'music';
  if (!tabs.some(t => t[0] === tab)) tab = 'music';
  const body = h('div', {class: 'stack'});
  root.append(h('div', {class: 'toolbar'}, segmented(tabs.map(([id, label]) => [id, label]), tab, t => { sessionStorage.setItem('tiiny.studioTab', t); go(`studio/${t}`); }),
    h('span', {class: 'spacer'}), linkBtn('Gallery', '#/gallery', {ic: 'grid'})), body);
  const pickers = [];
  const picker = (kind, cb) => { const p = modelPicker(kind, cb); pickers.push(p); return p; };
  ctx.on('models', () => pickers.forEach(p => p.render()));
  ctx.on('running', () => pickers.forEach(p => p.render()));
  ctx.on('loading', () => pickers.forEach(p => p.renderStatus()));
  const run = () => { clear(body); pickers.length = 0; S.dropHandler = null; (tabs.find(t => t[0] === tab) || tabs[0])[2](body, ctx, picker); };
  if (!S.modelsAt) refreshModels().then(() => { if (ctx.alive()) run(); }); else run();
  refreshRunning();
}

/* ------------------------------------------------------------------ Music */
const SONG_TAGS = [['verse', 'Verse'], ['chorus', 'Chorus'], ['bridge', 'Bridge'], ['intro', 'Intro'], ['outro', 'Outro'], ['inst', 'Instrumental']];
const STYLE_IDEAS = ['upbeat pop, female vocals, synths', 'acoustic folk, warm male vocals, guitar', 'lo-fi hip hop, mellow, piano',
  'rock anthem, electric guitar, drums', 'cinematic orchestral, strings, epic', 'jazz ballad, saxophone, soft vocals'];

function studioMusic(el, ctx, picker) {
  if (!modelsOf('music').length) { el.append(card({}, noModelState('music', 'music'))); return; }
  const resumeId = ctx.query.get('resume');
  const mp = picker('music', id => loadInfo(id));
  const lyrics = h('textarea', {class: 'input mono', rows: 11, spellcheck: 'true',
    placeholder: '[verse]\nWalking through the city lights\nEvery window tells a story\n\n[chorus]\nWe sing along tonight\nUntil the morning comes'});
  const insertTag = tag => {
    const pos = lyrics.selectionStart ?? lyrics.value.length;
    const before = lyrics.value.slice(0, pos), after = lyrics.value.slice(pos);
    const ins = `${before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : ''}[${tag}]\n`;
    lyrics.value = before + ins + after;
    lyrics.focus();
    lyrics.selectionStart = lyrics.selectionEnd = pos + ins.length;
    try { localStorage.setItem('tiiny.studio.lyrics', lyrics.value); } catch { /* ignore */ }
  };
  const caption = h('input', {class: 'input', placeholder: 'Style and instruments, e.g. “soft pop with acoustic guitar”'});
  try { lyrics.value = localStorage.getItem('tiiny.studio.lyrics') || ''; caption.value = localStorage.getItem('tiiny.studio.caption') || ''; } catch { /* ignore */ }
  lyrics.addEventListener('input', debounce(() => { try { localStorage.setItem('tiiny.studio.lyrics', lyrics.value); } catch { /* ignore */ } }, 400));
  caption.addEventListener('input', debounce(() => { try { localStorage.setItem('tiiny.studio.caption', caption.value); } catch { /* ignore */ } }, 400));
  let gtype = 'mixed';
  const typeSeg = segmented([['mixed', 'Song'], ['vocal', 'Vocals only'], ['bgm', 'Instrumental'], ['separate', 'Song + separate tracks']], gtype, v => { gtype = v; });
  const lengthIn = h('input', {class: 'input', type: 'number', min: 10, max: 600, step: 5, placeholder: 'model default'});
  const lengthField = h('div', {class: 'field', hidden: true}, h('label', {}, 'Length (seconds)'), lengthIn);
  const adv = {seed: h('input', {class: 'input', type: 'number', placeholder: 'random'}), steps: h('input', {class: 'input', type: 'number', min: 1, placeholder: 'default'}),
    temperature: h('input', {class: 'input', type: 'number', step: '0.05', min: 0, placeholder: 'default'}), top_k: h('input', {class: 'input', type: 'number', min: 1, placeholder: 'default'}),
    top_p: h('input', {class: 'input', type: 'number', step: '0.01', min: 0, max: 1, placeholder: 'default'})};
  let refFile = null;
  const refInfo = h('span', {class: 'small muted'}, 'None');
  const refInput = h('input', {type: 'file', accept: 'audio/*', hidden: true});
  refInput.addEventListener('change', async () => {
    const f = refInput.files[0]; refInput.value = '';
    if (!f) return;
    try {
      const wav = await toWav(f, {rate: 48000, channels: 2, maxSeconds: 15});
      if (wav.seconds < 10) { toast('The style reference must be at least 10 seconds long', 'err'); return; }
      refFile = {blob: wav.blob, name: f.name};
      clear(refInfo).append(`${f.name} (first 10 s are used) `, iconBtn('x', 'Remove', () => { refFile = null; clear(refInfo).append('None'); }));
    } catch (e) { toast('Couldn’t read that audio file', 'err', {detail: e.message}); }
  });
  const infoNote = h('div', {class: 'small muted'});
  async function loadInfo(id) {
    clear(infoNote);
    lengthField.hidden = true;
    if (!id || !S.running.has(id)) return;
    const r = await dev('/v1/music/info', {query: {model: id}, quiet: true, silent: true});
    if (!r.ok || !r.json) return;
    const j = r.json;
    const schema = JSON.stringify(j.config_schema || j.schema || {});
    lengthField.hidden = !/seconds_total/.test(schema);
    const d = {...(j.defaults?.global || {}), ...(j.default_config || {})};
    for (const [k, inp] of Object.entries(adv)) if (d[k] != null && k !== 'seed' && !(k === 'top_p' && !d[k])) inp.placeholder = String(d[k]);
    const max = j.model_info?.model?.codec_llm_duration;
    if (max) { lengthIn.max = max; infoNote.textContent = `Songs can be up to about ${Math.floor(max / 60)} min ${max % 60 ? `${max % 60} s` : ''} long.`.replace(' long.', ' long.').trim(); }
    if (d.seconds_total) lengthIn.placeholder = String(d.seconds_total);
  }
  const job = studioJob('music', ctx, {onDone: j => { if (j.status === 'done') { recent.load(); if (j.result?.gallery_id) showResult(j.result.gallery_id); } }});
  const resultEl = h('div');
  async function showResult(gid) {
    try {
      const it = await GalleryAPI.get(gid);
      clear(resultEl).append(h('div', {class: 'song-result'}, h('strong', {}, it.title), h('audio', {src: gUrl(it), controls: true, autoplay: true, style: {width: '100%'}}),
        h('div', {class: 'row wrap gap-sm'},
          it.params?.mode === 'preview' && it.params?.session_id && !it.params?.resumed ? btn('Continue to the full song', () => startResume(it), {kind: 'primary', small: true, icon: 'music'}) : null,
          (it.files || []).filter(f => f.role !== 'thumb').map(f => h('a', {class: 'btn sm', href: GalleryAPI.fileUrl(it.id, f.name, true), download: f.name}, icon('download'), f.name)))));
    } catch { /* gone */ }
  }
  const collect = () => {
    const cfg = {lyrics: lyrics.value.trim(), caption: caption.value.trim(), generation_type: gtype};
    if (!lengthField.hidden && lengthIn.value) cfg.seconds_total = Number(lengthIn.value);
    for (const [k, inp] of Object.entries(adv)) if (inp.value !== '') cfg[k] = Number(inp.value);
    return cfg;
  };
  async function start(mode) {
    if (job.busy) { toast('A song is already being made', 'info'); return; }
    const cfg = collect();
    if (!cfg.lyrics && gtype !== 'bgm') { lyrics.focus(); toast('Write some lyrics first (or choose “Instrumental”)', 'info'); return; }
    if (!(await ensureLoaded(mp.value))) return;
    const body = {model: mp.value, mode, config: cfg};
    if (refFile) body.reference_file_id = (await uploadFile(refFile.blob, null, 'reference.wav')).id;
    try { job.attach(await StudioAPI.start('music', body)); } catch (e) { toast('Couldn’t start', 'err', {detail: e.message}); }
  }
  async function startResume(it) {
    if (job.busy) { toast('A song is already being made', 'info'); return; }
    if (!(await ensureLoaded(it.model || mp.value))) return;
    const cfg = {};
    for (const [k, inp] of Object.entries(adv)) if (inp.value !== '') cfg[k] = Number(inp.value);
    try { job.attach(await StudioAPI.start('music', {model: it.model || mp.value, mode: 'resume', parent_id: it.id, config: cfg})); }
    catch (e) { toast('Couldn’t continue that preview', 'err', {detail: e.message}); }
  }
  const recent = recentStrip('audio', ctx, {title: 'Recent songs'});
  const resumeBanner = h('div');
  if (resumeId) GalleryAPI.get(resumeId).then(it => {
    clear(resumeBanner).append(h('div', {class: 'banner info'}, icon('music'), h('div', {class: 'text'}, h('strong', {}, `Continue “${it.title}”`),
      h('span', {class: 'small'}, 'The preview is extended into the full song with the same lyrics and style. Each preview can be continued once.')),
      btn('Make the full song', () => startResume(it), {kind: 'primary', icon: 'play'})));
  }).catch(() => {});
  el.append(resumeBanner, h('div', {class: 'grid cols-2'},
    card({title: 'Write a song', ic: 'music', sub: 'Lyrics with section tags, plus a style'}, h('div', {class: 'form'}, mp.el,
      h('div', {class: 'field'}, h('label', {}, 'Lyrics'), h('div', {class: 'row wrap gap-sm'}, SONG_TAGS.map(([t, l]) => btn(`[${l}]`, () => insertTag(t), {small: true, kind: 'ghost'}))), lyrics,
        h('small', {class: 'hint'}, 'Put each section under a tag like [verse] or [chorus], one line per sung line.')),
      h('div', {class: 'field'}, h('label', {}, 'Style'), caption, h('div', {class: 'row wrap gap-sm'}, STYLE_IDEAS.map(s => h('button', {type: 'button', class: 'chip', onclick: () => { caption.value = s; caption.dispatchEvent(new Event('input')); }}, s)))),
      h('div', {class: 'field'}, h('label', {}, 'What to make'), typeSeg),
      lengthField,
      h('div', {class: 'field'}, h('label', {}, 'Style reference (optional)'), h('div', {class: 'row wrap gap-sm'}, btn('Choose audio…', () => refInput.click(), {small: true, icon: 'upload'}), refInfo, refInput),
        h('small', {class: 'hint'}, 'A song whose sound you like, at least 10 seconds long.')),
      h('details', {class: 'adv'}, h('summary', {}, 'Advanced'), h('div', {class: 'form-row'}, Object.entries(adv).map(([k, inp]) => h('div', {class: 'field'}, h('label', {}, k.replace('_', ' ')), inp)))),
      infoNote,
      h('div', {class: 'row wrap gap-sm'}, btn('Preview (8 s)', () => start('preview'), {icon: 'play'}), btn('Make the full song', () => start('full'), {kind: 'primary', icon: 'music'})))),
    card({title: 'Result', ic: 'speaker'}, h('div', {class: 'stack'}, job.el, resultEl, recent.el))));
  loadInfo(mp.value);
}

/* ------------------------------------------------------------------- 3D */
/* The background: the device's own step for it needs a model TiinyOS doesn't ship (BiRefNet), so an image model on the
   Tiiny made for this, FLUX.2-klein Background-Remove, cuts the object out; cutout.js then turns the plain backdrop it
   returns transparent, which TRELLIS.2 leaves out of the model. */
const BG_PROMPT = 'Remove the background from the image';
const bgModel = () => modelsOf('image').find(m => /background-remove/i.test(m.id));
function bgSize(w, hgt) {  // the picture's shape, longest side 768, both sides multiples of 16 (what the model takes)
  const s = 768 / Math.max(w, hgt);
  const r = v => Math.max(256, Math.round(v * s / 16) * 16);
  return [r(w), r(hgt)];
}

function studio3d(el, ctx, picker) {
  if (!modelsOf('model3d').length) { el.append(card({}, noModelState('model3d', 'image-to-3D'))); return; }
  const mp = picker('model3d');
  let bgMode = 'cut';
  let cut = null;   // {state: 'working' | 'done' | 'error', ...} for the picture shown
  let cutRun = 0;   // the newest cut-out; an older one that finishes later is ignored
  const cutBox = h('div', {class: 'stack-sm'});
  const img = imageInput({label: 'Picture of an object', hint: 'Works best with one object, seen from the front.', initialGalleryId: ctx.query.get('from'),
    onChange: () => { cutRun++; cut = null; if (bgMode === 'cut' && bgModel() && img.value) makeCut(); else renderCut(); }});
  S.dropHandler = files => img.setFile(files.find(f => f.type.startsWith('image/')));
  const onPaste = e => { const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/')); if (f) { e.preventDefault(); img.setFile(f); } };
  document.addEventListener('paste', onPaste);
  ctx.onCleanup(() => document.removeEventListener('paste', onPaste));
  let quality = 'fast';
  const qSeg = segmented([['fast', 'Fast'], ['balance', 'Balanced'], ['quality', 'Best']], quality, v => { quality = v; });
  const tex = h('input', {type: 'checkbox', checked: true});
  const simp = h('input', {type: 'checkbox', checked: true});
  const bgSeg = segmented([['cut', 'Cut it out (AI)'], ['keep', 'Keep it']], bgMode, v => {
    bgMode = v;
    if (v === 'cut' && bgModel() && img.value && (!cut || cut.state === 'error')) makeCut(); else renderCut();
  });
  async function makeCut() {
    const m = bgModel(), v = img.value;
    if (!m || !v) return renderCut();
    const run = ++cutRun;
    cut = {state: 'working'};
    renderCut();
    const wasLoaded = S.running.has(m.id);
    try {
      if (!(await ensureLoaded(m.id))) throw new Error(`${shortName(m.id)} isn’t loaded.`);
      const full = v.full || v.src;
      const [w, hgt] = bgSize(...await imageDims(full));
      const out = await dev('/v1/image/generate', {method: 'POST', json: {model: m.id, prompt: BG_PROMPT, width: w, height: hgt, steps: 4, image: await fitImage(full, w, hgt)},
        save: 'cutout.png', label: 'Cut out the background', timeout: 300, silent: true});
      if (!out.ok || !out.file) throw new Error(out.error || 'No picture came back.');
      const res = await cutoutBlob(fileHref(out.file));
      if (run === cutRun) cut = {state: 'done', model: m.id, ...res};
    } catch (e) {
      if (run === cutRun) cut = {state: 'error', error: e.message || String(e)};
    } finally {
      // loaded just for this: unload it again (it loads in seconds), so the 3D model has the NPU memory
      if (!wasLoaded && S.running.has(m.id)) dev(`/api/v1/models/${encPath(m.id)}/stop`, {method: 'POST', quiet: true, silent: true, timeout: 120}).then(refreshRunning);
    }
    if (run === cutRun) renderCut();
  }
  function renderCut() {
    clear(cutBox);
    const m = bgModel();
    if (bgMode === 'keep') { cutBox.append(h('small', {class: 'hint'}, 'The picture goes to the 3D model as it is, background and all.')); return; }
    if (!m) {
      cutBox.append(h('div', {class: 'banner info'}, icon('info'), h('div', {class: 'text'},
        h('strong', {}, 'Cutting out the background needs FLUX.2-klein Background-Remove'),
        h('span', {class: 'small'}, 'An image model that runs on your Tiiny (7.2 GB from the model store). Until it’s there, the picture is used as it is.')),
        btn('Get it', () => { sessionStorage.setItem('tiiny.modelsTab', 'store'); sessionStorage.setItem('tiiny.modelsQuery', 'Background-Remove'); go('models'); }, {small: true, icon: 'download'})));
      return;
    }
    if (!img.value) { cutBox.append(h('small', {class: 'hint'}, `When you choose a picture, ${shortName(m.id)} cuts out the object on your Tiiny.`)); return; }
    if (!cut || cut.state === 'working') { cutBox.append(h('div', {class: 'loading'}, h('span', {class: 'spinner'}), `Cutting out the background with ${shortName(m.id)}…`)); return; }
    if (cut.state === 'error') {
      cutBox.append(h('div', {class: 'banner err'}, icon('alert'), h('div', {class: 'text'}, h('strong', {}, 'The cut-out didn’t work'), h('span', {class: 'small'}, cut.error)),
        btn('Try again', makeCut, {small: true, icon: 'refresh'})));
      return;
    }
    cutBox.append(h('div', {class: 'cut-pair'},  // your picture is right above; this is what goes to the 3D model
      h('figure', {}, h('img', {class: 'checker', src: cut.url, alt: 'The cut-out'}), h('figcaption', {}, 'Goes to the 3D model'))),
      h('div', {class: 'row wrap gap-sm', style: {alignItems: 'center'}}, btn('Try again', makeCut, {small: true, icon: 'refresh', kind: 'ghost'}),
        h('small', {class: 'muted'}, cut.plain === false ? 'The background didn’t come out even, so check the edges.' : `Cut out by ${shortName(cut.model)}.`)));
  }
  renderCut();
  const seed = h('input', {class: 'input', type: 'number', placeholder: 'random', style: {maxWidth: '160px'}});
  const resultEl = h('div');
  const job = studioJob('model3d', ctx, {stages: STAGES_3D, onDone: j => { if (j.status === 'done' && j.result?.gallery_id) { showResult(j.result.gallery_id, j.result.notes); recent.load(); } }});
  async function showResult(gid, notes) {
    try {
      const it = await GalleryAPI.get(gid);
      clear(resultEl).append(h('div', {class: 'stack-sm'}, modelViewer(gUrl(it), {poster: gUrl(it, 'input'), alt: it.title}),
        (notes || []).length ? h('p', {class: 'small muted'}, notes.join(' ')) : null,
        h('div', {class: 'row wrap gap-sm'}, h('a', {class: 'btn sm primary', href: gUrl(it, 'main', true), download: 'model.glb'}, icon('download'), 'Download GLB'),
          linkBtn('Open in the gallery', `#/gallery?kind=model3d&open=${it.id}`, {ic: 'grid'}))));
    } catch { /* gone */ }
  }
  const recent = recentStrip('model3d', ctx, {title: 'Recent 3D models', limit: 4});
  el.append(h('div', {class: 'grid cols-2'},
    card({title: 'Turn a picture into a 3D model', ic: 'cube', sub: 'Runs in five steps on the device and makes a textured GLB'}, h('div', {class: 'form'}, mp.el, img.el,
      h('div', {class: 'field'}, h('label', {}, 'Quality'), qSeg, h('small', {class: 'hint'}, 'Fast takes roughly 8–10 minutes; better quality takes longer.')),
      h('label', {class: 'check'}, tex, h('span', {}, h('span', {}, 'Paint a texture'), h('small', {class: 'muted'}, 'Off gives a plain grey shape, much faster.'))),
      h('label', {class: 'check'}, simp, h('span', {}, h('span', {}, 'Simplify the mesh'), h('small', {class: 'muted'}, 'Smaller files that open everywhere.'))),
      h('div', {class: 'field'}, h('label', {}, 'Background'), bgSeg, cutBox),
      h('div', {class: 'field'}, h('label', {}, 'Seed'), seed),
      h('div', {}, btn('Make the 3D model', async () => {
        if (job.busy) { toast('A 3D model is already being made', 'info'); return; }
        if (!img.value) { toast('Choose a picture first', 'info'); return; }
        const useCut = bgMode === 'cut' && bgModel();
        if (useCut && (!cut || cut.state === 'working')) { toast('Wait for the cut-out to finish', 'info'); return; }
        if (useCut && cut.state !== 'done') { toast('The cut-out didn’t work. Try again, or keep the background.', 'info'); return; }
        if (!(await ensureLoaded(mp.value))) return;
        const spec = await img.spec('image');
        if (useCut) Object.assign(spec, {cutout_file_id: (await uploadFile(cut.blob, null, 'cutout.png')).id, cutout_model: cut.model});
        const options = {quality, texture: tex.checked, simplify: simp.checked, remove_background: bgMode === 'cut'};
        if (seed.value !== '') options.seed = Number(seed.value);
        try { clear(resultEl); job.attach(await StudioAPI.start('3d', {model: mp.value, options, ...spec})); }
        catch (e) { toast('Couldn’t start', 'err', {detail: e.message}); }
      }, {kind: 'primary', icon: 'cube'})))),
    card({title: 'Result', ic: 'cube'}, h('div', {class: 'stack'}, job.el, resultEl, recent.el))));
}

/* ----------------------------------------------------------------- Video */
function studioVideo(el, ctx, picker) {
  if (!modelsOf('video').length) { el.append(card({}, noModelState('video', 'video'))); return; }
  const mp = picker('video');
  const prompt = h('textarea', {class: 'input', rows: 4, placeholder: 'A paper boat sailing through a neon-lit rainy city, slow camera pan'});
  const negative = h('input', {class: 'input', placeholder: 'blurry, distorted (optional)'});
  const size = h('select', {class: 'input'}, [['', 'Model default'], ['1280x704', 'Landscape 1280 × 704'], ['704x1280', 'Portrait 704 × 1280']].map(([v, l]) => h('option', {value: v}, l)));
  const seconds = h('input', {class: 'input', type: 'number', min: 1, max: 20, value: 5});
  const steps = h('input', {class: 'input', type: 'number', min: 1, placeholder: 'default'});
  const seed = h('input', {class: 'input', type: 'number', placeholder: 'random'});
  const ref = imageInput({label: 'Start from a picture (optional)', hint: 'PNG, JPEG or WebP. The video follows its look.', initialGalleryId: ctx.query.get('from')});
  S.dropHandler = files => ref.setFile(files.find(f => f.type.startsWith('image/')));
  const resultEl = h('div');
  const job = studioJob('video', ctx, {onDone: j => { if (j.status === 'done' && j.result?.gallery_id) { showResult(j.result.gallery_id); recent.load(); } }});
  async function showResult(gid) {
    try {
      const it = await GalleryAPI.get(gid);
      clear(resultEl).append(h('div', {class: 'stack-sm'}, h('video', {src: gUrl(it), controls: true, autoplay: true, loop: true, style: {width: '100%', borderRadius: '10px'}}),
        h('div', {class: 'row wrap gap-sm'}, h('a', {class: 'btn sm primary', href: gUrl(it, 'main', true), download: 'video.mp4'}, icon('download'), 'Download MP4'))));
    } catch { /* gone */ }
  }
  const recent = recentStrip('video', ctx, {title: 'Recent videos', limit: 4});
  el.append(h('div', {class: 'grid cols-2'},
    card({title: 'Make a video', ic: 'film'}, h('div', {class: 'form'}, mp.el,
      h('div', {class: 'field'}, h('label', {}, 'Describe it'), prompt), h('div', {class: 'field'}, h('label', {}, 'Avoid'), negative),
      h('div', {class: 'form-row'}, h('div', {class: 'field'}, h('label', {}, 'Size'), size), h('div', {class: 'field'}, h('label', {}, 'Seconds'), seconds)),
      h('div', {class: 'form-row'}, h('div', {class: 'field'}, h('label', {}, 'Steps'), steps), h('div', {class: 'field'}, h('label', {}, 'Seed'), seed)),
      ref.el,
      h('div', {}, btn('Make the video', async () => {
        if (!prompt.value.trim()) { prompt.focus(); return; }
        if (!(await ensureLoaded(mp.value))) return;
        const body = {model: mp.value, prompt: prompt.value.trim()};
        if (negative.value.trim()) body.negative_prompt = negative.value.trim();
        if (size.value) body.size = size.value;
        if (seconds.value) body.seconds = Number(seconds.value);
        if (steps.value) body.steps = Number(steps.value);
        if (seed.value !== '') body.seed = Number(seed.value);
        Object.assign(body, (await ref.spec('reference')) || {});
        try { clear(resultEl); job.attach(await StudioAPI.start('video', body)); }
        catch (e) { toast('Couldn’t start', 'err', {detail: e.message}); }
      }, {kind: 'primary', icon: 'film'}), h('p', {class: 'faint small'}, 'Finished videos are kept on the device for only an hour, so the panel downloads each one as soon as it’s ready.')))),
    card({title: 'Result', ic: 'film'}, h('div', {class: 'stack'}, job.el, resultEl, recent.el))));
}

registerView({id: 'studio', order: 61, group: 'create', title: 'Studio', ic: 'music', sub: 'Songs, 3D models and videos made on your device', render: viewStudio});
