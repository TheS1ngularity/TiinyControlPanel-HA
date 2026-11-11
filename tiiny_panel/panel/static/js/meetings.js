/* Meetings: live transcription from the microphone (or a recording), then notes written by a chat model. */
'use strict';

const MeetAPI = {
  list: async () => (await api('/api/meetings')).meetings,
  get: id => api(`/api/meetings/${id}`),
  create: body => api('/api/meetings', {method: 'POST', body}),
  update: (id, patch) => api(`/api/meetings/${id}`, {method: 'PATCH', body: patch}),
  remove: id => api(`/api/meetings/${id}`, {method: 'DELETE', body: {}}),
  segments: (id, segments) => api(`/api/meetings/${id}/segments`, {method: 'POST', body: {segments}}),
  summarize: (id, model) => api(`/api/meetings/${id}/summarize`, {method: 'POST', body: {model}}),
  toVault: id => api(`/api/meetings/${id}/to-vault`, {method: 'POST', body: {}}),
  toProject: (id, pid) => api(`/api/meetings/${id}/to-project`, {method: 'POST', body: {project_id: pid}}),
  exportUrl: id => `/api/meetings/${id}/export?token=${encodeURIComponent(TOKEN)}`,
};
const ASR_RATE = 16000;
const SEG_MIN = 12, SEG_TARGET = 18, SEG_MAX = 26;  // seconds per piece sent to speech recognition
const SILENCE_RMS = 0.006;
const MEET_LANGS = [['', 'Detect automatically'], ['en', 'English'], ['zh', 'Chinese'], ['es', 'Spanish'], ['de', 'German'], ['fr', 'French'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['sv', 'Swedish'], ['no', 'Norwegian'], ['da', 'Danish'], ['fi', 'Finnish'],
  ['pl', 'Polish'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['ko', 'Korean']];
// Phrases speech models tend to "hear" in silence or noise
const ASR_PHANTOMS = /^(thank you\.?|thanks for watching!?|thank you for watching\.?|subtitles by .*|you|bye\.?|\.+|music|\[music\]|♪+)$/i;
const Meet = {active: null};  // the recording in progress: {id, rec, queue, title}

function fmtClock(s) {
  s = Math.max(0, Math.floor(s || 0));
  const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
function rmsOf(a, from = 0, to = a.length) {
  let e = 0;
  const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) e += a[i] * a[i];
  return Math.sqrt(e / n);
}
/* Where to cut: the middle of the quietest 0.3 s between minS and maxS. */
function findCut(a, rate, minS, maxS) {
  const win = Math.round(rate * 0.3), hop = Math.round(rate * 0.05);
  const lo = Math.round(minS * rate), hi = Math.min(a.length, Math.round(maxS * rate));
  let best = hi, bestE = Infinity;
  for (let s = lo; s + win <= hi; s += hop) {
    let e = 0;
    for (let i = s; i < s + win; i += 2) e += a[i] * a[i];
    if (e < bestE) { bestE = e; best = s + (win >> 1); }
  }
  return best;
}
/* Split a whole recording into pieces of SEG_MIN..SEG_MAX seconds, cut at pauses. */
function splitRecording(samples, rate = ASR_RATE) {
  const out = [];
  let start = 0;
  while (samples.length - start > rate * SEG_MAX) {
    const view = samples.subarray(start);
    const cut = findCut(view, rate, SEG_MIN, SEG_MAX);
    out.push({start: start / rate, end: (start + cut) / rate, samples: samples.slice(start, start + cut)});
    start += cut;
  }
  if (samples.length - start > rate * 0.5) out.push({start: start / rate, end: samples.length / rate, samples: samples.slice(start)});
  return out;
}
function cleanAsr(text) {
  let t = String(text || '').replace(/<\|[^|]*\|>/g, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^language\s+\w+\s*<asr_text>/i, '').replace(/<\/?asr_text>/gi, '').trim();
  return t;
}

/* Sends pieces to speech recognition one at a time (the device runs one at a time anyway). */
class SegmentQueue {
  constructor({meetingId, model, language, onSegment, onChange}) {
    Object.assign(this, {meetingId, model, language, onSegment, onChange});
    this.items = [];
    this.busy = false;
    this.done = 0;
    this.total = 0;
    this.failed = 0;
    this.lastError = '';
    this.waiters = [];
  }
  push(seg) { this.items.push(seg); this.total++; this.pump(); this.onChange?.(); }
  idle() { return this.busy || this.items.length ? new Promise(r => this.waiters.push(r)) : Promise.resolve(); }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.items.length) {
      const seg = this.items.shift();
      await this.transcribe(seg);
      this.done++;
      this.onChange?.();
    }
    this.busy = false;
    this.onChange?.();
    this.waiters.splice(0).forEach(r => r());
  }
  async transcribe(seg) {
    const level = rmsOf(seg.samples);
    if (level < SILENCE_RMS) return;  // nothing was said
    const blob = encodeWav([seg.samples], ASR_RATE);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const up = await uploadFile(blob, null, 'segment.wav');
        const fields = {model: this.model};
        if (this.language) fields.language = this.language;
        const r = await dev('/v1/audio/transcriptions', {method: 'POST', form: {fields, files: {file: up.id}}, label: 'Transcribe meeting audio', timeout: 600, quiet: true, silent: true});
        if (!r.ok) throw new Error(r.error || 'Speech recognition failed');
        let text = typeof r.json === 'object' && r.json ? (pick(r.json, 'text', 'transcript') ?? '') : (r.text || '');
        text = cleanAsr(text);
        if (!text || (ASR_PHANTOMS.test(text) && level < SILENCE_RMS * 4)) return;
        const s = {start: Math.round(seg.start * 100) / 100, end: Math.round(seg.end * 100) / 100, text};
        await MeetAPI.segments(this.meetingId, [s]);
        this.onSegment?.(s);
        return;
      } catch (e) {
        this.lastError = e.message;
        if (attempt) { this.failed++; return; }
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }
}

/* Microphone → 16 kHz PCM via an AudioWorklet, cut into pieces at pauses. */
class MicRecorder {
  constructor({onSegment, onLevel}) {
    Object.assign(this, {onSegment, onLevel});
    this.chunks = [];
    this.buffered = 0;
    this.offset = 0;   // samples already handed out as pieces
    this.paused = false;
    this.started = 0;
  }
  get seconds() { return (this.offset + this.buffered) / ASR_RATE; }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1}});
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.audioWorklet.addModule('/static/js/pcm-worklet.js');
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture', {processorOptions: {targetRate: ASR_RATE}});
    this.node.port.onmessage = e => this.onChunk(e.data);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.src.connect(this.node);
    this.node.connect(mute).connect(this.ctx.destination);  // keeps the worklet running
    this.started = Date.now();
  }
  onChunk(chunk) {
    if (this.paused) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.onLevel?.(rmsOf(chunk));
    const secs = this.buffered / ASR_RATE;
    if (secs < SEG_TARGET) return;
    const all = this.joined();
    const tail = rmsOf(all, Math.max(0, all.length - Math.round(0.35 * ASR_RATE)));
    const avg = rmsOf(all);
    if (secs >= SEG_MAX) this.emit(all, findCut(all, ASR_RATE, SEG_MIN, SEG_MAX));
    else if (tail < Math.max(SILENCE_RMS, avg * 0.25)) this.emit(all, all.length);  // a natural pause
  }
  joined() {
    if (this.chunks.length === 1) return this.chunks[0];
    const all = new Float32Array(this.buffered);
    let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    this.chunks = [all];
    return all;
  }
  emit(all, cut) {
    const piece = all.slice(0, cut);
    const rest = all.slice(cut);
    this.onSegment({start: this.offset / ASR_RATE, end: (this.offset + cut) / ASR_RATE, samples: piece});
    this.offset += cut;
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
  }
  pause() { this.paused = true; this.node?.port.postMessage('pause'); }
  resume() { this.paused = false; this.node?.port.postMessage('resume'); }
  async stop() {
    this.node?.port.postMessage('flush');
    await new Promise(r => setTimeout(r, 150));
    this.paused = true;
    if (this.buffered > ASR_RATE * 0.5) this.emit(this.joined(), this.buffered);
    this.stream?.getTracks().forEach(t => t.stop());
    try { await this.ctx?.close(); } catch { /* already closed */ }
  }
}

/* A recording file → mono 16 kHz samples (the browser decodes and resamples). */
async function decodeTo16k(file) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  let ac;
  try { ac = new Ctx({sampleRate: ASR_RATE}); } catch { ac = new Ctx(); }
  try {
    const buf = await ac.decodeAudioData(await file.arrayBuffer());
    let mono;
    if (buf.sampleRate === ASR_RATE) {
      mono = new Float32Array(buf.length);
      for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels; }
    } else {
      const off = new OfflineAudioContext(1, Math.ceil(buf.duration * ASR_RATE), ASR_RATE);
      const src = off.createBufferSource();
      src.buffer = buf;
      src.connect(off.destination);
      src.start();
      mono = (await off.startRendering()).getChannelData(0);
    }
    return {samples: mono, seconds: buf.duration};
  } finally { ac.close(); }
}

function asrPicker() {
  const sel = h('select', {class: 'input'});
  const list = modelsOf('asr').sort((a, b) => S.running.has(b.id) - S.running.has(a.id));
  const saved = localStorage.getItem('tiiny.meet.asr');
  if (!list.length) sel.append(h('option', {value: ''}, 'No speech recognition model on your device'));
  for (const m of list) sel.append(h('option', {value: m.id, selected: m.id === saved}, `${S.running.has(m.id) ? '● ' : ''}${m.display_name || m.name}`));
  sel.addEventListener('change', () => localStorage.setItem('tiiny.meet.asr', sel.value));
  return sel;
}
function langPicker(value) {
  const sel = h('select', {class: 'input'}, MEET_LANGS.map(([v, l]) => h('option', {value: v, selected: v === (value ?? localStorage.getItem('tiiny.meet.lang') ?? '')}, l)));
  sel.addEventListener('change', () => localStorage.setItem('tiiny.meet.lang', sel.value));
  return sel;
}
function chatModelPicker() {
  const list = modelsOf('chat').sort((a, b) => (S.running.has(b.id) - S.running.has(a.id)) || ((a.npu_usage || 99) - (b.npu_usage || 99)));
  const saved = localStorage.getItem('tiiny.meet.chat');
  const sel = h('select', {class: 'input sm', style: {width: 'auto', maxWidth: 'min(260px, 100%)'}}, list.map(m => h('option', {value: m.id, selected: m.id === saved}, `${S.running.has(m.id) ? '● ' : ''}${m.display_name || m.name}`)));
  sel.addEventListener('change', () => localStorage.setItem('tiiny.meet.chat', sel.value));
  return sel;
}

function updateRecPill() {
  let pill = document.getElementById('rec-pill');
  const a = Meet.active;
  if (!a || (S.view === 'meetings' && location.hash.includes(a.id))) { pill?.remove(); return; }
  if (!pill) {
    pill = h('a', {id: 'rec-pill', class: 'rec-pill'});
    document.body.append(pill);
  }
  pill.href = `#/meetings/${a.id}`;
  clear(pill).append(h('span', {class: 'recording'}, h('i')), `${a.rec.paused ? 'Paused' : 'Recording'} ${fmtClock(a.rec.seconds)}`);
}
setInterval(() => { if (Meet.active) updateRecPill(); }, 1000);
window.addEventListener('hashchange', () => setTimeout(updateRecPill, 50));
window.addEventListener('beforeunload', e => { if (Meet.active) { e.preventDefault(); e.returnValue = ''; } });

async function startLiveMeeting({language, asrModel}) {
  if (Meet.active) { go(`meetings/${Meet.active.id}`); return; }
  if (!asrModel) { toast('Download a speech recognition model first', 'err'); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) { toast('This browser can’t record audio here', 'err'); return; }
  if (!(await ensureLoaded(asrModel))) return;
  const rec0 = await MeetAPI.create({source: 'live', language, asr_model: asrModel});
  const queue = new SegmentQueue({meetingId: rec0.id, model: asrModel, language, onSegment: s => emit('meeting-segment', {id: rec0.id, seg: s}), onChange: () => emit('meeting-queue', rec0.id)});
  const rec = new MicRecorder({onSegment: seg => queue.push(seg), onLevel: lvl => emit('meeting-level', lvl)});
  try { await rec.start(); }
  catch (e) {
    await MeetAPI.remove(rec0.id).catch(() => {});
    toast('The microphone couldn’t be opened', 'err', {detail: e.name === 'NotAllowedError' ? 'Allow microphone access for this page in the browser’s address bar, then try again.' : e.message});
    return;
  }
  Meet.active = {id: rec0.id, rec, queue, title: rec0.title};
  go(`meetings/${rec0.id}`);
}

async function stopLiveMeeting() {
  const a = Meet.active;
  if (!a) return;
  await a.rec.stop();
  Meet.active = null;
  updateRecPill();
  emit('meeting-queue', a.id);
  await MeetAPI.update(a.id, {status: 'transcribing', duration: a.rec.seconds});
  emit('meeting-changed', a.id);
  await a.queue.idle();
  await MeetAPI.update(a.id, {status: 'transcribed'});
  emit('meeting-changed', a.id);
  return a;
}

async function transcribeFile(file, {language, asrModel}) {
  if (!asrModel) { toast('Download a speech recognition model first', 'err'); return; }
  const dismiss = toast(`Reading ${file.name}…`, 'info', {timeout: 600000});
  let audio;
  try { audio = await decodeTo16k(file); }
  catch (e) { dismiss(); toast('That file couldn’t be read as audio', 'err', {detail: e.message}); return; }
  dismiss();
  if (!(await ensureLoaded(asrModel))) return;
  const title = file.name.replace(/\.[^.]+$/, '');
  const rec0 = await MeetAPI.create({source: 'file', language, asr_model: asrModel, title, file_name: file.name});
  await MeetAPI.update(rec0.id, {status: 'transcribing', duration: audio.seconds});
  const pieces = splitRecording(audio.samples);
  const queue = new SegmentQueue({meetingId: rec0.id, model: asrModel, language, onSegment: s => emit('meeting-segment', {id: rec0.id, seg: s}), onChange: () => emit('meeting-queue', rec0.id)});
  Meet.files = Meet.files || new Map();
  Meet.files.set(rec0.id, queue);
  pieces.forEach(p => queue.push(p));
  go(`meetings/${rec0.id}`);
  queue.idle().then(async () => {
    Meet.files.delete(rec0.id);
    await MeetAPI.update(rec0.id, {status: 'transcribed'});
    emit('meeting-changed', rec0.id);
    notify('Transcript ready', title);
  });
}

function viewMeetings(root, ctx) {
  if (ctx.params[0]) return viewMeeting(root, ctx, ctx.params[0]);
  const listEl = h('div', {}, loadingBlock());
  const startBody = h('div');
  const fileBody = h('div');
  root.append(h('div', {class: 'grid cols-2'},
    card({title: 'Start a meeting', ic: 'mic', sub: `Live transcript from ${onServer() ? 'this device' : 'this computer'}’s microphone`}, startBody),
    card({title: 'Transcribe a recording', ic: 'upload', sub: 'An audio or video file of a meeting, call or lecture'}, fileBody)),
  card({title: 'Past meetings', ic: 'users'}, listEl));
  function renderStart() {
    clear(startBody); clear(fileBody);
    if (!modelsOf('asr').length) {
      const none = emptyState('mic', 'No speech recognition model', 'Download one (for example Whisper) from the model store first.',
        h('a', {class: 'btn sm primary', href: '#/models', onclick: () => sessionStorage.setItem('tiiny.modelsTab', 'store')}, icon('download'), 'Open the model store'));
      startBody.append(none);
      return;
    }
    const asr = asrPicker(), lang = langPicker();
    startBody.append(h('div', {class: 'form'}, h('div', {class: 'form-row'}, h('div', {class: 'field'}, h('label', {}, 'Speech model'), asr), h('div', {class: 'field'}, h('label', {}, 'Language'), lang)),
      Meet.active ? h('div', {class: 'banner info'}, icon('mic'), h('div', {class: 'text'}, 'A meeting is being recorded.'), linkBtn('Open it', `#/meetings/${Meet.active.id}`, {kind: 'primary'}))
        : h('div', {}, btn('Start recording', () => startLiveMeeting({language: lang.value, asrModel: asr.value}), {kind: 'primary', icon: 'mic'})),
      h('p', {class: 'faint small'}, 'Audio is cut into short pieces and transcribed by your Tiiny as you talk; nothing leaves your network. Keep this tab open while recording.')));
    const asr2 = asrPicker(), lang2 = langPicker();
    const input = h('input', {type: 'file', accept: 'audio/*,video/*', hidden: true});
    input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; if (f) transcribeFile(f, {language: lang2.value, asrModel: asr2.value}); });
    S.dropHandler = files => { const f = files.find(x => /^(audio|video)\//.test(x.type)) || files[0]; if (f) transcribeFile(f, {language: lang2.value, asrModel: asr2.value}); };
    fileBody.append(h('div', {class: 'form'}, h('div', {class: 'form-row'}, h('div', {class: 'field'}, h('label', {}, 'Speech model'), asr2), h('div', {class: 'field'}, h('label', {}, 'Language'), lang2)),
      h('div', {class: 'dropzone small-zone', role: 'button', tabindex: '0', onclick: () => input.click()}, icon('upload'), h('strong', {}, 'Drop a recording here or click to choose'),
        h('span', {class: 'small muted'}, 'MP3, M4A, WAV, OGG, WebM, MP4… Your browser decodes it; long files take a moment.')), input));
  }
  async function load() {
    let list;
    try { list = await MeetAPI.list(); } catch (e) { clear(listEl).append(errorBlock(e.message, {retry: load})); return; }
    if (!ctx.alive()) return;
    clear(listEl);
    if (!list.length) { listEl.append(h('p', {class: 'muted'}, 'No meetings yet.')); return; }
    listEl.append(h('div', {class: 'stack-sm'}, list.map(m => h('a', {class: 'net', href: `#/meetings/${m.id}`}, icon(m.source === 'file' ? 'file' : 'mic'),
      h('div', {class: 'spacer', style: {minWidth: 0}}, h('strong', {}, m.title), h('div', {class: 'cell-sub'}, `${fmtAgo(m.created)} · ${fmtClock(m.duration)} · ${m.words.toLocaleString()} words`)),
      m.status === 'recording' && Meet.active?.id === m.id ? badge('Recording', 'err') : m.status === 'transcribing' ? badge('Transcribing', 'accent') : m.has_summary ? badge('Summary', 'ok', 'check') : null))));
  }
  if (!S.modelsAt) refreshModels().then(() => { if (ctx.alive()) renderStart(); }); else renderStart();
  load();
}

function viewMeeting(root, ctx, mid) {
  let rec = null;
  let editing = false;
  const head = h('div');
  const recorderEl = h('div');
  const summaryEl = h('div');
  const highlightsEl = h('div');
  const highlightsCard = card({title: 'Action items, decisions and questions', icon: 'check'}, highlightsEl);
  const transcriptEl = h('div', {class: 'transcript'});
  const queueEl = h('div', {class: 'small muted'});
  const notes = h('textarea', {class: 'input', rows: 5, placeholder: 'Your own notes. The summary takes them into account.'});
  notes.addEventListener('input', debounce(() => MeetAPI.update(mid, {notes: notes.value}).catch(() => {}), 600));
  let q = '';
  root.append(head, recorderEl, h('div', {class: 'grid cols-2 meet-grid'},
    card({title: 'Summary', ic: 'spark'}, summaryEl),
    card({title: 'Transcript', ic: 'file', actions: [searchBox('Search…', v => { q = v.toLowerCase(); renderTranscript(); })]}, h('div', {class: 'stack'}, queueEl, transcriptEl,
      h('div', {class: 'field'}, h('label', {}, 'Notes'), notes)))), highlightsCard);

  async function load() {
    try { rec = await MeetAPI.get(mid); } catch (e) { clear(root).append(errorBlock(e.message, {title: 'Meeting not found'})); return; }
    if (!ctx.alive()) return;
    if (document.activeElement !== notes) notes.value = rec.notes || '';
    ctx.setTitle(rec.title, `${fmtAgo(rec.created)} · ${fmtClock(rec.duration)}`);
    renderHead(); renderRecorder(); renderSummary(); renderHighlights(); renderTranscript(); renderQueue();
    if (rec.job && !watching) watchSummary(rec.job.id);
    const live = Meet.active?.id === mid || Meet.files?.has(mid);
    if (!live && ['transcribed', 'transcribing'].includes(rec.status) && !rec.summary_md && !rec.job && rec.status === 'transcribed' && autoSummary && (rec.segments || []).length) {
      autoSummary = false;
      startSummary();
    }
  }
  let autoSummary = !!ctx.query.get('summarize') || true;
  function renderHead() {
    clear(head).append(h('div', {class: 'row wrap'}, linkBtn('All meetings', '#/meetings', {ic: 'chevronLeft'}), h('span', {class: 'spacer'}),
      h('a', {class: 'btn sm', href: MeetAPI.exportUrl(mid), download: ''}, icon('download'), 'Markdown'),
      btn('Save to Vault', async () => {
        const r = await MeetAPI.toVault(mid);
        toast(r.indexed === false ? 'Saved, but the Vault couldn’t index it yet' : 'Saved to the Vault', r.indexed === false ? 'info' : 'ok', {detail: r.filename});
      }, {small: true, icon: 'archive'}),
      btn('Add to a project', async () => {
        const projects = await ProjectsAPI.list();
        if (!projects.length) { toast('Create a project first', 'info', {action: {label: 'Projects', fn: () => go('projects')}}); return; }
        const v = await formDialog({title: 'Add these notes to a project', submitLabel: 'Add', intro: 'The summary and transcript become a note in the project’s knowledge, so its chats can use them.',
          fields: [{name: 'pid', label: 'Project', type: 'select', value: projects[0].id, options: projects.map(p => ({value: p.id, label: p.name}))}]});
        if (!v) return;
        await MeetAPI.toProject(mid, v.pid);
        toast('Added to the project', 'ok', {action: {label: 'Open it', fn: () => go(`projects/${v.pid}`)}});
      }, {small: true, icon: 'folder'}),
      menuButton([
        {label: 'Rename', icon: 'edit', fn: async () => {
          const v = await formDialog({title: 'Rename meeting', fields: [{name: 'title', label: 'Title', value: rec.title, required: true, maxlength: 200}]});
          if (v) { await MeetAPI.update(mid, {title: v.title}); load(); }
        }},
        {label: 'Copy transcript', icon: 'copy', fn: () => copyText((rec.segments || []).map(s => `[${fmtClock(s.start)}] ${s.text}`).join('\n'), 'Transcript copied')},
        {label: 'Delete meeting', icon: 'trash', danger: true, fn: async () => {
          if (Meet.active?.id === mid) { toast('Stop the recording first', 'info'); return; }
          if (!(await confirmDialog({title: 'Delete this meeting?', message: 'The transcript and summary are deleted. Copies saved to the Vault or a project stay.', confirmLabel: 'Delete', danger: true}))) return;
          await MeetAPI.remove(mid); go('meetings');
        }},
      ])));
  }
  let levelEl = null, timerEl = null;
  function renderRecorder() {
    clear(recorderEl);
    const a = Meet.active?.id === mid ? Meet.active : null;
    if (a) {
      levelEl = h('div', {class: 'level'}, h('i'));
      timerEl = h('span', {class: 'rec-timer'}, fmtClock(a.rec.seconds));
      recorderEl.append(h('div', {class: 'recorder'}, h('span', {class: 'recording big'}, h('i')), timerEl, levelEl, h('span', {class: 'spacer'}),
        a.rec.paused ? btn('Resume', () => { a.rec.resume(); renderRecorder(); }, {icon: 'play'}) : btn('Pause', () => { a.rec.pause(); renderRecorder(); }, {icon: 'pause', kind: 'ghost'}),
        btn('Stop', async () => { await stopLiveMeeting(); load(); }, {icon: 'stop', kind: 'danger solid'})));
    } else if (rec?.status === 'recording') {
      recorderEl.append(h('div', {class: 'banner warn'}, icon('alert'), h('div', {class: 'text'}, h('strong', {}, 'This recording stopped'),
        h('span', {class: 'small'}, 'The page was closed or reloaded while recording. Everything transcribed until then is kept.')),
        btn('Mark as finished', async () => { await MeetAPI.update(mid, {status: 'transcribed'}); load(); }, {small: true})));
    }
  }
  ctx.on('meeting-level', e => {
    if (!levelEl) return;
    levelEl.firstChild.style.width = `${Math.min(100, Math.sqrt(e.detail) * 260)}%`;
    if (timerEl && Meet.active) timerEl.textContent = fmtClock(Meet.active.rec.seconds);
  });
  ctx.every(1000, () => { if (timerEl && Meet.active?.id === mid) timerEl.textContent = fmtClock(Meet.active.rec.seconds); });
  function renderQueue() {
    clear(queueEl);
    const queue = Meet.active?.id === mid ? Meet.active.queue : Meet.files?.get(mid);
    if (queue && (queue.busy || queue.items.length)) {
      append(queueEl, [h('div', {class: 'row gap-sm'}, h('span', {class: 'spinner'}),
        Meet.files?.has(mid) ? `Transcribing part ${Math.min(queue.done + 1, queue.total)} of ${queue.total}…` : `Transcribing… ${queue.items.length + (queue.busy ? 1 : 0)} piece(s) waiting`),
        Meet.files?.has(mid) ? progressBar(queue.done / Math.max(1, queue.total) * 100) : null]);
    } else if (rec?.status === 'transcribing' && !queue) {
      queueEl.append('The transcription was interrupted; the parts done so far are below.');
    }
    if (queue?.failed) queueEl.append(h('div', {class: 'warn-text'}, `${queue.failed} piece(s) couldn’t be transcribed: ${queue.lastError}`));
  }
  ctx.on('meeting-queue', e => { if (e.detail === mid) renderQueue(); });
  ctx.on('meeting-segment', e => { if (e.detail.id === mid && rec) { rec.segments = [...(rec.segments || []), e.detail.seg].sort((a, b) => a.start - b.start); renderTranscript(true); } });
  ctx.on('meeting-changed', e => { if (e.detail === mid) load(); });
  function renderTranscript(scroll) {
    const segs = (rec?.segments || []).filter(s => !q || s.text.toLowerCase().includes(q));
    const atBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 40;
    clear(transcriptEl);
    if (!segs.length) {
      transcriptEl.append(h('p', {class: 'muted small'}, q ? 'No matches.' : Meet.active?.id === mid ? 'Start talking. Text appears here about 20 seconds behind.' : 'No transcript.'));
      return;
    }
    transcriptEl.append(...segs.map(s => h('div', {class: 'seg-line', dataset: {start: String(s.start)}}, h('span', {class: 'ts'}, fmtClock(s.start)), h('span', {}, s.text))));
    if (scroll && atBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
  /* Action items, decisions and open questions a decision model found (System → Decision models). */
  function renderHighlights() {
    clear(highlightsEl);
    const list = rec?.highlights;
    const can = decisionOn('meeting_highlights') && (rec?.segments || []).length && Meet.active?.id !== mid;
    highlightsCard.hidden = !Array.isArray(list) && !can;
    if (highlightsCard.hidden) return;
    const findBtn = can ? btn(Array.isArray(list) ? 'Find again' : 'Find them', async () => {
      const job = await api(`/api/meetings/${encodeURIComponent(mid)}/highlights`, {method: 'POST', body: {}});
      rec.job = job;
      renderSummary();
      watchSummary(job.id);
    }, {small: true, kind: Array.isArray(list) ? 'ghost' : 'primary', icon: 'check', disabled: !!rec.job}) : null;
    if (!Array.isArray(list)) {
      append(highlightsEl, [h('p', {class: 'muted small'}, rec.job ? 'Working on it…' : 'A decision model can go through the transcript and list the action items, decisions and open questions.'), findBtn]);
      return;
    }
    const jump = start => {
      if (q) {   // a search would hide the line: clear it
        q = '';
        const box = transcriptEl.closest('.card')?.querySelector('input[type=search]');
        if (box) box.value = '';
        renderTranscript();
      }
      const line = [...transcriptEl.querySelectorAll('.seg-line')].find(el => Math.abs(Number(el.dataset.start) - start) < 0.05);
      if (!line) return;
      line.scrollIntoView({block: 'center', behavior: 'smooth'});
      line.classList.add('flash');
      setTimeout(() => line.classList.remove('flash'), 1600);
    };
    const groups = [['action', 'Action items'], ['decision', 'Decisions'], ['question', 'Open questions']].map(([k, title]) => {
      const items = list.filter(x => x.kind === k);
      return items.length ? h('div', {class: 'stack-sm'}, h('div', {class: 'section-title'}, `${title} (${items.length})`),
        h('ul', {class: 'meet-hl'}, items.map(x => h('li', {}, h('button', {type: 'button', class: 'link-btn mono small', title: 'Show it in the transcript', onclick: () => jump(x.start)}, fmtClock(x.start)), ' ', x.text)))) : null;
    }).filter(Boolean);
    highlightsEl.append(groups.length ? h('div', {class: 'grid cols-3'}, groups) : h('p', {class: 'muted small'}, 'Nothing like that in this meeting.'),
      h('div', {class: 'row wrap gap-sm', style: {alignItems: 'center', marginTop: '8px'}}, rec.highlights_model ? h('span', {class: 'small faint'}, `Found by ${shortName(rec.highlights_model)}`) : null, findBtn));
  }
  let watching = null;
  function watchSummary(jid) {
    watching = jid;
    const ac = new AbortController();
    ctx.onCleanup(() => ac.abort());
    followJob(jid, j => { if (rec) { rec.job = j; renderSummary(); } }, {signal: ac.signal}).then(j => {
      watching = null;
      if (!j) return;
      if (j.status === 'failed') toast('The summary failed', 'err', {detail: j.error});
      if (ctx.alive()) load();
    });
  }
  async function startSummary(model) {
    model = model || localStorage.getItem('tiiny.meet.chat') || modelsOf('chat').find(m => S.running.has(m.id))?.id || modelsOf('chat')[0]?.id;
    if (!model) { toast('Download a chat model to write summaries', 'info'); return; }
    if (!(await ensureLoaded(model))) return;
    try { const j = await MeetAPI.summarize(mid, model); rec.job = j; renderSummary(); watchSummary(j.id); }
    catch (e) { toast('Couldn’t start the summary', 'err', {detail: e.message}); }
  }
  function renderSummary() {
    clear(summaryEl);
    if (!rec) return;
    if (rec.job && rec.job.status === 'running') {
      summaryEl.append(h('div', {class: 'stack-sm'}, h('div', {class: 'row small'}, h('span', {class: 'spinner'}), rec.job.message || 'Writing the summary…'),
        progressBar((rec.job.progress || 0) * 100, {indeterminate: !rec.job.progress})));
      return;
    }
    const live = Meet.active?.id === mid;
    const picker = chatModelPicker();
    const redo = h('div', {class: 'row wrap gap-sm'}, picker, btn(rec.summary_md ? 'Write it again' : 'Write the summary', () => startSummary(picker.value),
      {small: true, kind: rec.summary_md ? 'ghost' : 'primary', icon: 'spark', disabled: live || !(rec.segments || []).length}));
    if (editing) {
      const ta = h('textarea', {class: 'input mono', rows: 18}, rec.summary_md || '');
      summaryEl.append(h('div', {class: 'stack-sm'}, ta, h('div', {class: 'row gap-sm'},
        btn('Save', async () => { await MeetAPI.update(mid, {summary_md: ta.value}); editing = false; load(); }, {small: true, kind: 'primary', icon: 'check'}),
        btn('Cancel', () => { editing = false; renderSummary(); }, {small: true, kind: 'ghost'}))));
      return;
    }
    if (!rec.summary_md) {
      summaryEl.append(h('p', {class: 'muted'}, live ? 'The summary is written when you stop the recording.' : (rec.segments || []).length ? 'No summary yet.' : 'There is nothing to summarize yet.'), redo);
      return;
    }
    summaryEl.append(h('div', {class: 'md meet-summary', html: renderMarkdown(rec.summary_md)}),
      h('div', {class: 'row wrap gap-sm'}, btn('Edit', () => { editing = true; renderSummary(); }, {small: true, kind: 'ghost', icon: 'edit'}),
        btn('Copy', () => copyText(rec.summary_md, 'Summary copied'), {small: true, kind: 'ghost', icon: 'copy'})),
      h('details', {class: 'small'}, h('summary', {}, 'Rewrite with another model'), redo));
  }
  if (!S.modelsAt) refreshModels().then(() => { if (ctx.alive()) load(); }); else load();
}

registerView({id: 'meetings', order: 40, group: 'main', title: 'Meetings', ic: 'users', sub: 'Live transcripts and meeting notes, made on your device', render: viewMeetings});
