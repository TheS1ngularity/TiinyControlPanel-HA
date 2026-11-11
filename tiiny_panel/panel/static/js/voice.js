/* Voice in chat: 🎤 to say a message (speech recognition on your Tiiny; the words land in the message box, unsent) and
   🔊 Read aloud under each answer (text to speech on your Tiiny).
   Uses the recorder from meetings.js (MicRecorder, cleanAsr, rmsOf, ASR_RATE, SILENCE_RMS, ASR_PHANTOMS), encodeWav
   from studio.js, and ttsModeFor and ttsError from app.js: the page's scripts share one scope. */
'use strict';

const VOICE_MAX_SECONDS = 120;
const Voice = {reading: null};   // the answer being read aloud: {key, stop}
/* Voice… → "When you’re done": how long after its last use a model 🎤 or 🔊 had to load is unloaded again, in seconds.
   null: it stays loaded. */
const VOICE_UNLOAD = {'2': 120, now: 0, '10': 600, keep: null};

/* What you chose under the chat's ⋮ → Voice…, kept in this browser. The speech recognition model and language are
   shared with Meetings. */
function voicePrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('tiiny.readAloud') || '{}') || {}; } catch { p = {}; }
  return {tts: p.tts || '', voice: p.voice || '', design: p.design || '', unload: p.unload in VOICE_UNLOAD ? p.unload : '2',
    asr: localStorage.getItem('tiiny.meet.asr') || '', lang: localStorage.getItem('tiiny.meet.lang') || ''};
}
function saveVoicePrefs(p) {
  localStorage.setItem('tiiny.readAloud', JSON.stringify({tts: p.tts || '', voice: p.voice || '', design: p.design || '',
    unload: p.unload in VOICE_UNLOAD ? p.unload : '2'}));
  if (p.asr !== undefined) localStorage.setItem('tiiny.meet.asr', p.asr || '');
  if (p.lang !== undefined) localStorage.setItem('tiiny.meet.lang', p.lang || '');
}
/* The model to use for a kind: the one you chose if it's still on the device, else a loaded one, else the smallest. */
function voiceModel(kind, chosen, usable = () => true) {
  const list = modelsOf(kind).filter(usable);
  if (chosen && list.some(m => m.id === chosen)) return chosen;
  list.sort((a, b) => (S.running.has(b.id) - S.running.has(a.id)) || ((num(a.size) || 9e15) - (num(b.size) || 9e15)));
  return list[0]?.id || '';
}
function openStoreFor(query) {
  sessionStorage.setItem('tiiny.modelsTab', 'store');
  sessionStorage.setItem('tiiny.modelsQuery', query);
  go('models');
}
async function voiceModelsReady() {
  if (!S.modelsAt) await refreshModels();
}
/* The device's answer when a request names a model that isn't loaded (it never loads one by itself). */
const notLoaded = r => !r.ok && /not loaded/i.test(r.error || '');
/* 🎤 and 🔊 borrow the model when they have to load it. When you're done, the panel server unloads it again after the
   wait chosen under Voice…, so that happens even if you close the page. Using it for anything else in the meantime
   keeps it loaded (see setBorrowed in app.js). A model that was already loaded isn't borrowed, so it stays loaded.
   Resolves to the function that gives it back, or null. */
async function borrowForVoice(model) {
  const after = VOICE_UNLOAD[voicePrefs().unload];
  if (after === null) return null;
  await refreshRunning();   // was it loaded before? Ask the device, not this page's last look
  const session = uid();
  try {
    const r = await api('/api/models/borrowed', {method: 'POST',
      body: {model, session, state: 'using', after, loaded: S.running.has(model) || S.loading.has(model)}});
    setBorrowed(r.borrowed);
    if (!r.ok) return null;
  } catch { return null; }   // then it just stays loaded
  let given = false;
  return async () => {
    if (given) return;
    given = true;
    try { setBorrowed((await api('/api/models/borrowed', {method: 'POST', body: {model, session, state: 'done', after: VOICE_UNLOAD[voicePrefs().unload] ?? after}})).borrowed); }
    catch { /* the panel stops waiting for this page after a while */ }
  };
}

/* ---- 🎤 ---------------------------------------------------------------------------------------------------- */
/* The mic button for a message box. protect(): the chat's model, which making room for the speech model must not
   unload. Returns {el, busy, finish, cancel}. */
function voiceInput({textarea, protect}) {
  const b = h('button', {class: 'btn ghost icon-only mic-btn', type: 'button', title: 'Say your message', 'aria-label': 'Say your message'}, icon('mic'));
  const level = h('i');
  const meter = h('span', {class: 'mic-meter', 'aria-hidden': 'true'}, level);
  const clock = h('span', {class: 'mic-clock', 'aria-live': 'off'}, '0:00');
  const status = h('span', {class: 'mic-status', 'aria-live': 'polite'});
  const wrap = h('span', {class: 'mic'}, b, meter, clock, status);
  let state = 'idle';   // idle | starting | recording | working
  let rec = null, timer = 0, started = 0, cancelled = false, ready = null, leases = [], model = '', texts = [], queue = Promise.resolve(), failed = '';
  const secure = () => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && !!window.AudioWorkletNode;
  if (!secure()) b.classList.add('unavailable');

  function paint() {
    wrap.className = `mic ${state}`;
    b.title = state === 'recording' ? 'Stop and write it down (Enter)' : state === 'working' ? 'Writing it down…' : 'Say your message';
    clear(b).append(icon(state === 'recording' ? 'stop' : 'mic'));
    b.disabled = state === 'working' || state === 'starting';
    status.textContent = state === 'working' ? 'Writing it down…' : state === 'starting' ? 'Starting the microphone…' : '';
  }
  function tick() {
    const s = (Date.now() - started) / 1000;
    clock.textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    if (s >= VOICE_MAX_SECONDS) finish();
  }

  async function start() {
    if (!secure()) {
      const https = location.protocol === 'http:' && !/^(localhost|127\.|\[::1\])/.test(location.hostname);
      toast('The microphone needs a secure connection', 'info', {timeout: 12000, detail: https
        ? `Browsers only allow the microphone on secure pages. Open the panel at https://${location.host}${location.pathname} instead ` +
          '(the browser warns once: the panel made its own certificate).' + (S.health?.tls && !S.health.tls.on ? ' HTTPS is switched off on the server (TIINY_UI_TLS=off).' : '')
        : 'Browsers only allow the microphone on secure pages. Open the panel at http://127.0.0.1 on this computer.'});
      return;
    }
    await voiceModelsReady();
    model = voiceModel('asr', voicePrefs().asr);
    if (!model) {
      toast('There’s no speech recognition model on your Tiiny yet', 'info', {detail: 'Get one (for example Whisper) from the model store, then try again.',
        action: {label: 'Find one', fn: () => openStoreFor('ASR')}});
      return;
    }
    state = 'starting';
    cancelled = false;
    failed = '';
    texts = [];
    queue = Promise.resolve();
    paint();
    const r = rec = new MicRecorder({onSegment: seg => { queue = queue.then(() => transcribe(seg)).catch(e => { failed = failed || e.message || String(e); }); },
      onLevel: v => { level.style.width = `${Math.min(100, Math.round(v * 900))}%`; }});
    try { await r.start(); }
    catch (e) {
      if (rec !== r) return;   // cancelled meanwhile
      rec = null;
      state = 'idle';
      paint();
      toast(/denied|not allowed|permission/i.test(e.message || e.name) ? 'The browser didn’t allow the microphone' : 'Couldn’t start the microphone', 'err',
        {detail: /denied|not allowed|permission/i.test(e.message || e.name) ? 'Allow the microphone for this page in your browser’s site settings, then try again.' : (e.message || String(e))});
      return;
    }
    if (rec !== r) { try { await r.stop(); } catch { /* already stopped */ } return; }   // the chat was left while the microphone started
    state = 'recording';
    started = Date.now();
    clock.textContent = '0:00';
    timer = setInterval(tick, 250);
    paint();
    // Load the speech model while you talk (borrowed: given back when you're done); making room never unloads the chat's model.
    ready = borrowAndLoad();
  }
  function borrowAndLoad() {
    const lease = borrowForVoice(model).catch(() => null);
    leases.push(lease);
    return lease.then(() => S.running.has(model) || loadModel(model, {quiet: true, borrow: true, protect: new Set([protect()].filter(Boolean))}));
  }
  /* Done with the speech model, once it has finished loading: if 🎤 loaded it, the panel unloads it again later. */
  function giveBack() {
    const ls = leases, r = ready;
    leases = [];
    ready = null;
    if (ls.length) Promise.resolve(r).catch(() => {}).then(() => Promise.all(ls)).then(gives => gives.forEach(give => give?.())).catch(() => {});
  }

  async function transcribe(seg) {
    if (cancelled || failed) return;
    const lvl = rmsOf(seg.samples);
    if (lvl < SILENCE_RMS) return;   // nothing was said
    if (!(await ready)) { failed = `${shortName(model)} wasn’t loaded, so nothing was written down.`; return; }
    const up = await uploadFile(encodeWav([seg.samples], ASR_RATE), null, 'speech.wav');
    const fields = {model};
    const lang = voicePrefs().lang;
    if (lang) fields.language = lang;
    const ask = () => dev('/v1/audio/transcriptions', {method: 'POST', form: {fields, files: {file: up.id}}, label: 'Write down what you said', timeout: 300, quiet: true, silent: true});
    let r = await ask();
    if (notLoaded(r) && !cancelled) {   // unloaded meanwhile (given back a moment ago, another page): load it again, once
      await refreshRunning();
      ready = borrowAndLoad();
      if (!(await ready)) { failed = `${shortName(model)} wasn’t loaded, so nothing was written down.`; return; }
      r = await ask();
    }
    if (!r.ok) { failed = r.error || 'Speech recognition failed.'; return; }
    const text = cleanAsr(typeof r.json === 'object' && r.json ? (pick(r.json, 'text', 'transcript') ?? '') : (r.text || ''));
    if (text && !(ASR_PHANTOMS.test(text) && lvl < SILENCE_RMS * 4)) texts.push(text);
  }

  async function finish() {
    if (state !== 'recording') return;
    clearInterval(timer);
    state = 'working';
    paint();
    try {
      await rec.stop();   // hands over the last piece
      await queue.catch(e => { failed = e.message || String(e); });
    } finally {
      rec = null;
      state = 'idle';
      level.style.width = '0';
      paint();
      giveBack();
    }
    if (cancelled) return;
    if (failed) { toast('Couldn’t write down what you said', 'err', {detail: failed}); return; }
    const said = texts.join(' ').replace(/\s+/g, ' ').trim();
    if (!said) { toast('No speech was heard', 'info', {detail: 'Check that the right microphone is picked in your browser, and speak a little louder.'}); return; }
    const at = textarea.selectionStart ?? textarea.value.length, end = textarea.selectionEnd ?? at;
    const before = textarea.value.slice(0, at), after = textarea.value.slice(end);
    const glue = before && !/\s$/.test(before) ? ' ' : '';
    textarea.value = before + glue + said + (after && !/^\s/.test(after) ? ' ' : '') + after;
    const pos = (before + glue + said).length;
    textarea.focus();
    textarea.setSelectionRange(pos, pos);
    textarea.dispatchEvent(new Event('input', {bubbles: true}));
  }

  async function cancel() {
    if (state !== 'recording' && state !== 'starting') return;
    cancelled = true;
    clearInterval(timer);
    const r = rec;
    rec = null;
    state = 'idle';
    level.style.width = '0';
    paint();
    giveBack();
    try { await r?.stop(); } catch { /* already stopped */ }
  }

  b.addEventListener('click', () => { if (state === 'recording') finish(); else if (state === 'idle') start(); });
  paint();
  return {el: wrap, busy: () => state === 'recording', finish, cancel};
}

/* ---- 🔊 ---------------------------------------------------------------------------------------------------- */
/* An answer as plain sentences to speak: no Markdown, no citations, code read as "(code)". */
function speakableText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?(```|$)/g, ' (code) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
    .replace(/\[\d{1,3}(?:\s*,\s*\d{1,3})*\]/g, '')
    .replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, '$1.')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, '')
    .replace(/\.\.(\s|$)/g, '.$1')
    .replace(/\s+/g, ' ')
    .trim();
}
/* Pieces of a sentence or a few: the first one short, so speaking starts quickly. */
function speechChunks(text, first = 140, max = 280) {
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]+["'”’)\]]*\s*|[^.!?。！？]+$/g) || [text];
  const out = [];
  let cur = '';
  for (let s of sentences) {
    s = s.trim();
    if (!s) continue;
    while (s.length > max) {   // a very long sentence: cut at a comma or a space
      const cut = Math.max(s.lastIndexOf(', ', max), s.lastIndexOf(' ', max));
      const at = cut > max / 3 ? cut + 1 : max;
      if (cur) { out.push(cur); cur = ''; }
      out.push(s.slice(0, at).trim());
      s = s.slice(at).trim();
    }
    const limit = out.length ? max : first;
    if (cur && (cur + ' ' + s).length > limit) { out.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out.filter(Boolean);
}
/* The request for one piece: the way of speaking follows the model (see toolTTS in app.js). */
function readAloudBody(model, text, prefs) {
  const body = {model, input: text, response_format: 'mp3'};
  const mode = ttsModeFor(model);
  if (mode === 'design') body.instructions = prefs.design || 'A calm, warm voice, speaking clearly at a relaxed pace.';
  else if (mode === 'builtin' && prefs.voice) body.voice = prefs.voice;
  return body;
}
const usableForReading = m => ttsModeFor(m.id) !== 'clone';   // copying a voice needs a recording each time

function paintReadButtons() {
  for (const b of document.querySelectorAll('[data-read-key]')) {
    const on = Voice.reading?.key === b.dataset.readKey;
    b.classList.toggle('reading', on);
    clear(b).append(icon(on ? 'stop' : 'speaker'), h('span', {}, on ? 'Stop' : 'Read aloud'));
    b.title = on ? 'Stop reading' : 'Read this answer aloud with a voice model on your Tiiny';
  }
}
function stopReading() {
  const r = Voice.reading;
  Voice.reading = null;
  if (r) r.stop();
  paintReadButtons();
}
/* The 🔊 button under an answer. `key` tells answers apart (it survives the chat being drawn again). */
function readAloudButton(text, key) {
  const b = h('button', {class: 'btn ghost sm read-btn', type: 'button', dataset: {readKey: key}},
    icon('speaker'), h('span', {}, 'Read aloud'));
  b.addEventListener('click', () => { if (Voice.reading?.key === key) stopReading(); else readAloud(text, key); });
  queueMicrotask(paintReadButtons);
  return b;
}
async function readAloud(markdown, key) {
  stopReading();
  // One audio element, started inside the click: phones (iOS) then let it play the following pieces too.
  const audio = new Audio();
  audio.preload = 'auto';
  const silence = URL.createObjectURL(encodeWav([new Float32Array(800)], 16000));
  audio.src = silence;
  audio.play().catch(() => {});
  let stopped = false, wake = null;
  const gives = [];   // borrowForVoice() results: given back when reading ends
  const me = {key, stop: () => { stopped = true; audio.pause(); audio.removeAttribute('src'); audio.load(); wake?.(); }};
  Voice.reading = me;
  paintReadButtons();
  const done = () => {
    URL.revokeObjectURL(silence);
    Promise.all(gives).then(gs => gs.forEach(give => give?.())).catch(() => {});
    if (Voice.reading === me) { Voice.reading = null; paintReadButtons(); }
  };
  try {
    const text = speakableText(markdown);
    if (!text) return;
    await voiceModelsReady();
    const prefs = voicePrefs();
    const model = voiceModel('tts', prefs.tts, usableForReading);
    if (!model) {
      toast('There’s no voice model on your Tiiny yet', 'info', {detail: 'Get a text-to-speech model (for example Qwen3-TTS) from the model store, then try again.',
        action: {label: 'Find one', fn: () => openStoreFor('TTS')}});
      return;
    }
    const borrowAndLoad = async () => {   // if 🔊 has to load it, the panel unloads it again later
      const give = borrowForVoice(model).catch(() => null);
      gives.push(give);
      await give;
      return !stopped && (S.running.has(model) || ensureLoaded(model, {borrow: true}));
    };
    if (!(await borrowAndLoad()) || stopped) return;
    const chunks = speechChunks(text);
    let reloading = null;
    const synth = async piece => {
      const ask = () => dev('/v1/audio/speech', {method: 'POST', json: readAloudBody(model, piece, prefs), save: 'speech.mp3', label: 'Read an answer aloud', timeout: 300, silent: true});
      let r = await ask();
      if (notLoaded(r) && !stopped) {   // unloaded meanwhile (given back a moment ago, another page): load it again, once
        reloading = reloading || refreshRunning().then(borrowAndLoad).finally(() => { reloading = null; });
        if (await reloading) r = await ask();
      }
      if (!r.ok || !r.file) throw new Error(ttsError(r.error || 'No audio came back.'));
      return fileHref(r.file);
    };
    let next = synth(chunks[0]);
    for (let i = 0; i < chunks.length && !stopped; i++) {
      const url = await next;
      if (stopped) break;
      next = i + 1 < chunks.length ? synth(chunks[i + 1]) : null;   // the next piece is made while this one plays
      next?.catch(() => {});
      await new Promise(resolve => {
        wake = resolve;
        audio.onended = resolve;
        audio.onerror = resolve;
        audio.src = url;
        audio.play().catch(resolve);
      });
    }
  } catch (e) {
    if (!stopped) toast('Couldn’t read it aloud', 'err', {detail: e.message || String(e)});
  } finally { done(); }
}

/* ---- ⋮ → Voice… ------------------------------------------------------------------------------------------ */
async function voiceSettings() {
  await voiceModelsReady();
  const p = voicePrefs();
  const label = m => `${S.running.has(m.id) ? '● ' : ''}${m.display_name || m.name}`;
  const tts = modelsOf('tts').filter(usableForReading), asr = modelsOf('asr');
  const v = await formDialog({title: 'Voice', submitLabel: 'Save', intro: 'For 🎤 (say a message) and 🔊 Read aloud in chats. These run on your Tiiny.',
    fields: [
      {name: 'asr', label: 'Speech recognition (for 🎤)', type: 'select', value: voiceModel('asr', p.asr),
        options: asr.length ? asr.map(m => ({value: m.id, label: label(m)})) : [{value: '', label: 'None on your Tiiny yet'}], hint: 'Meetings uses the same one.'},
      {name: 'lang', label: 'Language you speak', type: 'select', value: p.lang, options: MEET_LANGS.map(([value, l]) => ({value, label: l}))},
      {name: 'tts', label: 'Voice model (for 🔊)', type: 'select', value: voiceModel('tts', p.tts, usableForReading),
        options: tts.length ? tts.map(m => ({value: m.id, label: label(m)})) : [{value: '', label: 'None on your Tiiny yet'}],
        hint: 'Models made for copying a voice aren’t listed: they need a recording every time.'},
      {name: 'voice', label: 'Voice name', value: p.voice, placeholder: 'Empty: the model’s own voice', hint: 'For models with built-in voices (CustomVoice and others).'},
      {name: 'design', label: 'Describe the voice', type: 'textarea', rows: 2, value: p.design, placeholder: 'A calm, warm voice, speaking clearly at a relaxed pace.',
        hint: 'For VoiceDesign models.'},
      {name: 'unload', label: 'When you’re done', type: 'select', value: p.unload, options: [
        {value: '2', label: 'Unload the models 2 minutes after their last use'}, {value: 'now', label: 'Unload the models straight away'},
        {value: '10', label: 'Unload the models 10 minutes after their last use'}, {value: 'keep', label: 'Keep the models loaded'}],
        hint: 'Only the ones 🎤 or 🔊 had to load. A model that was already loaded stays loaded.'},
    ]});
  if (!v) return;
  saveVoicePrefs(v);
  if (v.unload === 'keep') Object.keys(S.borrowed).forEach(keepBorrowed);
  toast('Voice settings saved', 'ok', {timeout: 2000});
}
