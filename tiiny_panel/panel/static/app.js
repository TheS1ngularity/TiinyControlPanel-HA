/* Tiiny Control Panel: front end. Plain JavaScript, no build step. */
'use strict';

/* The session token. Paired phones get it in the page; on this computer the page fetches it (see getSessionToken). */
let TOKEN = document.querySelector('meta[name="tiiny-token"]')?.content || '';
const TOKEN_IN_PAGE = TOKEN !== '';
/* Server mode (tiiny_ui.py --server): the panel runs on another machine, a home server or the Docker image, so
   "this computer" is the server there. */
const onServer = () => !!S.health?.server;
const hereName = () => (onServer() ? 'the server' : 'this computer');
const DOCS_URL = 'https://dev.tiiny.ai/';

/* =========================================================================
   DOM and formatting helpers
   ========================================================================= */
const $ = (sel, root = document) => root.querySelector(sel);
const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'indeterminate', 'multiple', 'readOnly', 'hidden', 'open']);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v; // only ever used with markup built by this file
      else if (PROP_KEYS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  return append(el, kids);
}
function append(el, kids) {
  for (const kid of kids) {
    if (kid === undefined || kid === null || kid === false || kid === true) continue;
    if (Array.isArray(kid)) append(el, kid);
    else el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}
const clear = el => { el.replaceChildren(); return el; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }
const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const stripAnsi = s => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_0-?]/g, '');

function fmtBytes(n, {si = false} = {}) {
  n = Number(n);
  if (!isFinite(n)) return '—';
  const base = si ? 1000 : 1024, units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (Math.abs(n) >= base && i < units.length - 1) { n /= base; i++; }
  return `${i ? n.toFixed(n < 10 ? 1 : 0) : n} ${units[i]}`;
}
function toDate(v) {
  if (v === null || v === undefined || v === '' || v === 0) return null;
  let d;
  if (typeof v === 'number' || /^\d{9,13}(\.\d+)?$/.test(String(v))) { const n = Number(v); d = new Date(n < 1e12 ? n * 1000 : n); }
  else d = new Date(v);
  return isNaN(d) ? null : d;
}
function fmtDate(v) { const d = toDate(v); return d ? d.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'}) : (v ? String(v) : '—'); }
function fmtAgo(v) {
  const d = toDate(v); if (!d) return '—';
  const s = (Date.now() - d) / 1000;
  if (s < 0) return fmtDate(v);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return d.toLocaleDateString();
}
function fmtSecs(s) { s = Math.round(Number(s) || 0); return s < 90 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim(); }
/* 872 → "872", 1931 → "1.9K", 12345 → "12K" */
function fmtCount(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  try { return new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1}).format(n); }
  catch { return n < 1000 ? String(n) : n < 1e6 ? `${+(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K` : `${+(n / 1e6).toFixed(1)}M`; }
}
const ACRONYMS = {id: 'ID', npu: 'NPU', ram: 'RAM', soc: 'SoC', cpu: 'CPU', gpu: 'GPU', ip: 'IP', api: 'API', url: 'URL', asr: 'ASR', tts: 'TTS', ocr: 'OCR', mcp: 'MCP', ssid: 'SSID', usb: 'USB', mb: 'MB', gb: 'GB', ipv4: 'IPv4', ipv6: 'IPv6', sn: 'SN'};
function humanize(key) {
  const words = String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').trim().toLowerCase().split(/\s+/);
  return words.map((w, i) => ACRONYMS[w] || (i === 0 && w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}
const norm = k => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
function pick(o, ...names) {
  if (!o || typeof o !== 'object') return undefined;
  const map = {};
  for (const k of Object.keys(o)) map[norm(k)] = o[k];
  for (const n of names) { const v = map[norm(n)]; if (v !== undefined && v !== null && v !== '') return v; }
  return undefined;
}
function findArray(j, prefer = []) {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== 'object') return null;
  for (const k of [...prefer, 'data', 'items', 'results', 'list', 'networks', 'servers', 'sources', 'devices']) {
    for (const key of Object.keys(j)) if (key.toLowerCase() === k && Array.isArray(j[key])) return j[key];
  }
  for (const v of Object.values(j)) if (Array.isArray(v)) return v;
  for (const v of Object.values(j)) if (v && typeof v === 'object') { const a = findArray(v, prefer); if (a) return a; }
  return null;
}
function findUrl(obj, depth = 0) {
  if (typeof obj === 'string') return /^https?:\/\//.test(obj.trim()) ? obj.trim() : '';
  if (!obj || typeof obj !== 'object' || depth > 4) return '';
  for (const v of Object.values(obj)) { const u = findUrl(v, depth + 1); if (u) return u; }
  return '';
}
const encPath = id => String(id).split('/').map(encodeURIComponent).join('/');
const shortName = id => { const m = S.modelsById.get(id); return (m && (m.display_name || m.name)) || String(id).split('/').pop(); };
const fileHref = (rec, download = false) => `${rec.url}?token=${encodeURIComponent(TOKEN)}${download ? '&download=1' : ''}`;
/* Only web links from saved or device data become clickable links (never javascript: or file: ones). */
const safeUrl = u => (typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u.trim()) ? u.trim() : null);
/* Links to the panel's API saved in chats carry no token (it changes every launch): add the current one. */
function withToken(u) {
  if (typeof u !== 'string' || !u.startsWith('/api/')) return u;
  const url = new URL(u, location.origin);
  url.searchParams.set('token', TOKEN);
  return url.pathname + url.search;
}
const iconHref = path => `/api/dev/icon?path=${encodeURIComponent(path)}&token=${encodeURIComponent(TOKEN)}`;
function triggerDownload(url, name) { const a = h('a', {href: url, download: name || ''}); document.body.append(a); a.click(); a.remove(); }
async function copyText(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h('textarea', {style: {position: 'fixed', opacity: '0'}}); ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ } ta.remove();
  }
  toast(`${what} to the clipboard`, 'ok', {timeout: 2200});
}
function readAs(file, how) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('Could not read the file'));
    if (how === 'text') r.readAsText(file); else r.readAsDataURL(file);
  });
}

/* =========================================================================
   Icons (24×24 stroke icons)
   ========================================================================= */
const ICONS = {
  gauge: '<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  wand: '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M15 9h.01M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  terminal: '<path d="M4 17l6-6-6-6M12 19h8"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
  clip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 6l-10 7L2 6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
  bolt: '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  speaker: '<path d="M11 5L6 9H2v6h4l5 4zM15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z"/>',
  minus: '<path d="M5 12h14"/>',
  brain: '<path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24A2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24A2.5 2.5 0 0 0 14.5 2z"/>',
  usb: '<circle cx="10" cy="7" r="1"/><circle cx="4" cy="20" r="1"/><path d="M4.7 19.3L19 5M21 3l-3 1 2 2zM9.26 7.68L5 12l2 5M10 14l5 2 3.5-3.5M18 12l1-1 1 1-1 1z"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>',
  phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  archive: '<rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9M10 13h4"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  cube: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/>',
  film: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  chevronLeft: '<path d="M15 18l-6-6 6-6"/>',
};
function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = `icon ${cls}`.trim();
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

/* =========================================================================
   Shared state and a tiny event bus
   ========================================================================= */
const S = {
  health: null, overview: null, state: 'unknown',
  models: [], modelsById: new Map(), modelsAt: 0, modelsError: '',
  store: null, storeById: new Map(),
  running: new Set(), loading: new Map(),
  borrowed: {},   // models 🎤 and 🔊 loaded just for themselves: id → {for, using, after, unload_in} (see setBorrowed)
  deviceId: '', menu: null, view: null, dropHandler: null,
};
const bus = new EventTarget();
const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, {detail}));

/* =========================================================================
   Talking to the local server
   ========================================================================= */
/* On this computer the page carries no token. It swaps the sign-in this browser keeps for the panel's address
   (put there by the one-time link the panel opens; see tiinyui/browserauth.py) for this run's session token. */
const SIGNIN_KEY = 'tiiny-ui-credential';
const storedSignIn = () => { try { return localStorage.getItem(SIGNIN_KEY) || ''; } catch { return ''; } };
let sessionRequest = null;
function getSessionToken() {  // resolves to 'ok', 'signed-out' or 'no-server'
  sessionRequest = sessionRequest || (async () => {
    const cred = storedSignIn();
    if (!cred) return 'signed-out';
    let r;
    try { r = await fetch('/api/session', {method: 'POST', headers: {'X-Tiiny-Credential': cred}}); }
    catch { return 'no-server'; }
    const data = await r.json().catch(() => null);
    if (r.ok && data?.token) { TOKEN = data.token; return 'ok'; }
    return r.status === 401 ? 'signed-out' : 'no-server';
  })().finally(() => { sessionRequest = null; });
  return sessionRequest;
}

async function api(path, {method = 'GET', body, signal} = {}, retried = false) {
  const opts = {method, headers: {'X-Tiiny-Token': TOKEN}, signal};
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(path, opts); }
  catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Lost contact with the Tiiny Control Panel server. Is tiiny_ui.py still running?');
  }
  let data = null;
  try { data = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) {
    // The panel restarted since this page loaded: get the new session token and try once more.
    if (data?.session === 'expired' && !TOKEN_IN_PAGE && !retried) {
      const st = await getSessionToken();
      if (st === 'ok') return api(path, {method, body, signal}, true);
      if (st === 'signed-out') showSignedOut();
    }
    throw new Error((data && data.error) || `HTTP ${r.status}`);
  }
  return data;
}

function summarize(res) {
  if (res.file) return `Saved ${res.file.name} (${fmtBytes(res.file.size)})`;
  const j = res.json;
  if (Array.isArray(j)) return `${j.length} item(s)`;
  if (j && typeof j === 'object') { const s = JSON.stringify(j); return s.length > 600 ? s.slice(0, 600) + '…' : s; }
  return (res.text || '').slice(0, 600);
}

/* Call the device's HTTP API through the local server. */
/* The page a request comes from ("chat/c1", "playground?tool=image"): the dashboard's Right now card links back to it. */
const here = () => location.hash.replace(/^#\/?/, '').slice(0, 200);
async function dev(path, o = {}) {
  const {service = 'core', method = 'GET', query, json, form, save, headers, timeout, quiet = false, silent = false, label} = o;
  const body = {service, method, path, query, headers, timeout, save, from: here()};
  if (json !== undefined) body.json = json;
  if (form) body.form = form;
  let res;
  try { res = await api('/api/dev', {method: 'POST', body}); }
  catch (e) { res = {ok: false, status: null, error: e.message, request: `${method} ${path}`}; }
  if (!quiet || (!res.ok && !silent)) {  // background lookups (quiet + silent) stay out of the log
    Activity.add({kind: 'api', label: label || res.request || `${method} ${path}`, cmd: res.request, ok: res.ok,
      status: res.status, detail: res.ok ? summarize(res) : res.error, duration: res.duration});
  }
  if (!res.ok && !silent) toast(label ? `${label} failed` : 'The device returned an error', 'err', {detail: res.error});
  return res;
}

/* The Tiiny can answer /kb/finalize with 200 and "success": false (Tiiny's tool checks for it since 0.0.6): returns why,
   or '' when it didn't say it failed (older versions don't send the flag). */
function finalizeFailed(j) {
  if (!j || j.success !== false) return '';
  return [j.message, j.msg, j.detail, j.error].find(v => typeof v === 'string' && v.trim())?.trim() || 'Your Tiiny says indexing didn’t succeed.';
}

async function readSSE(resp, onEvent) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream: true});
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let ev = 'message', data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
        }
        if (!data) continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        onEvent(ev, parsed);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/* Stream a device response (used for model import progress). */
async function devStream(path, o, onEvent) {
  const {service = 'core', method = 'POST', json, query, label, signal} = o;
  const resp = await fetch('/api/dev/stream', {method: 'POST', signal,
    headers: {'Content-Type': 'application/json', 'X-Tiiny-Token': TOKEN},
    body: JSON.stringify({service, method, path, json, query, timeout: 3600, from: here()})});
  if (!resp.ok) { const d = await resp.json().catch(() => null); throw new Error(d?.error || `HTTP ${resp.status}`); }
  let result = {ok: false, error: 'The stream ended unexpectedly.'};
  await readSSE(resp, (ev, d) => { if (ev === 'done') result = d; else onEvent(ev, d); });
  Activity.add({kind: 'api', label: label || `${method} ${path}`, ok: result.ok, status: result.status, detail: result.error || 'Finished'});
  return result;
}

/* Run a one-shot tiiny CLI command. */
async function cli(args, o = {}) {
  const {yes = false, timeout = 120, quiet = false, silent = false, label, sensitive = false} = o;
  let res;
  try { res = await api('/api/cli', {method: 'POST', body: {args, yes, timeout}}); }
  catch (e) { res = {ok: false, code: null, cmd: 'tiiny ' + args.filter(a => typeof a === 'string').join(' '), stdout: '', stderr: e.message}; }
  if (!quiet || !res.ok) {
    Activity.add({kind: 'cli', label: label || res.cmd, cmd: res.cmd, ok: res.ok, status: res.code,
      detail: sensitive ? '[output hidden]' : ((res.stdout || '') + (res.stderr ? `\n${res.stderr}` : '')).trim(), duration: res.duration});
  }
  if (!res.ok && !silent) toast(`${label || res.cmd} failed`, 'err', {detail: cliError(res), action: {label: 'Open in terminal', fn: () => openTerminal({args, title: label})}});
  return res;
}
function cliError(res) {
  if (res.timed_out) return 'The command timed out.';
  const t = (res.stderr || '').trim() || (res.stdout || '').trim();
  return t ? t.split('\n').slice(-6).join('\n') : (res.code == null ? 'The command did not finish.' : `Exited with code ${res.code}.`);
}

function uploadFile(file, onProgress, name) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/api/upload?name=' + encodeURIComponent(name || file.name || 'file'));
    xhr.setRequestHeader('X-Tiiny-Token', TOKEN);
    xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let d = null;
      try { d = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300 && d) resolve(d);
      else reject(new Error((d && d.error) || `Upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: lost contact with the local server'));
    xhr.send(file);
  });
}

/* =========================================================================
   UI kit: buttons, cards, toasts, dialogs, menus
   ========================================================================= */
function btn(label, onClick, {kind = '', icon: ic, title, small = false, disabled = false, type = 'button'} = {}) {
  const b = h('button', {class: `btn ${kind} ${small ? 'sm' : ''} ${label ? '' : 'icon-only'}`.replace(/\s+/g, ' ').trim(), type, title: title || (label ? undefined : ''), disabled},
    ic && icon(ic), label && h('span', {}, label));
  if (onClick) {
    b.addEventListener('click', async e => {
      if (b.classList.contains('busy')) return;
      b.classList.add('busy');
      try { await onClick(e); }
      catch (err) { console.error(err); toast(err.message || String(err), 'err'); }
      finally { b.classList.remove('busy'); }
    });
  }
  return b;
}
const iconBtn = (ic, title, onClick, {kind = 'ghost', small = true} = {}) => btn('', onClick, {kind, icon: ic, title, small});
const linkBtn = (label, href, {ic, kind = 'ghost'} = {}) => h('a', {class: `btn sm ${kind}`, href}, ic && icon(ic), h('span', {}, label));

function card({title, icon: ic, sub, actions, cls = ''} = {}, ...body) {
  return h('section', {class: `card ${cls}`.trim()},
    (title || actions) && h('header', {class: 'card-head'},
      h('div', {class: 'titles'}, title && h('h2', {}, ic && icon(ic), title), sub && h('p', {class: 'muted'}, sub)),
      actions && h('div', {class: 'card-actions'}, actions)),
    h('div', {class: 'card-body'}, body));
}
function badge(text, kind = '', ic) { return h('span', {class: `badge ${kind}`.trim()}, ic && icon(ic), text); }
function emptyState(ic, title, text, ...actions) {
  return h('div', {class: 'empty'}, icon(ic), h('strong', {}, title), text && h('p', {}, text), actions.length ? h('div', {class: 'row wrap', style: {justifyContent: 'center', marginTop: '4px'}}, actions) : null);
}
const loadingBlock = (text = 'Loading…') => h('div', {class: 'loading'}, h('span', {class: 'spinner'}), text);
function errorBlock(message, {retry, title = 'Something went wrong'} = {}) {
  return h('div', {class: 'banner err'}, icon('alert'), h('div', {class: 'text'}, h('strong', {}, title), h('span', {class: 'small'}, message)),
    retry && btn('Try again', retry, {small: true, icon: 'refresh'}));
}
function kvList(entries) {
  const dl = h('dl', {class: 'kv'});
  for (const [k, v] of entries) {
    if (v === undefined || v === null || v === '') continue;
    dl.append(h('dt', {}, k), h('dd', {}, v));
  }
  return dl;
}
function progressBar(pct, {indeterminate = false, cls = ''} = {}) {
  const bar = h('div', {class: `bar ${cls} ${indeterminate ? 'indeterminate' : ''}`.trim()}, h('i'));
  if (!indeterminate) bar.firstChild.style.width = `${clamp(Number(pct) || 0, 0, 100)}%`;
  return bar;
}
function gauge({label, pct, value, sub}) {
  const level = pct >= 90 ? 'err' : pct >= 75 ? 'warn' : '';
  return h('div', {class: 'gauge'},
    h('div', {class: 'gauge-top'}, h('span', {class: 'gauge-label'}, label), h('span', {class: 'gauge-value'}, value ?? (pct == null ? '—' : `${Math.round(pct)}%`))),
    sub && h('div', {class: 'gauge-sub'}, sub),
    progressBar(pct ?? 0, {cls: level}));
}
function segmented(options, current, onChange) {
  const wrap = h('div', {class: 'seg', role: 'tablist'});
  const render = () => {
    clear(wrap);
    for (const [value, label, n] of options) {
      wrap.append(h('button', {type: 'button', role: 'tab', class: value === current ? 'active' : '', 'aria-selected': String(value === current),
        onclick: () => { if (current !== value) { current = value; render(); onChange(value); } }}, label, n != null && h('span', {class: 'n'}, String(n))));
    }
  };
  wrap.set = (value, newOptions) => { current = value; if (newOptions) options = newOptions; render(); };
  render();
  return wrap;
}
function searchBox(placeholder, onInput, value = '') {
  const input = h('input', {class: 'input', type: 'search', placeholder, value, 'aria-label': placeholder});
  input.addEventListener('input', debounce(() => onInput(input.value.trim()), 120));
  return h('div', {class: 'search'}, icon('search'), input);
}
function rawDetails(obj, label = 'Raw response') {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return h('details', {class: 'raw'}, h('summary', {}, label), h('pre', {}, text));
}
function switchInput(checked, onChange, label) {
  const input = h('input', {type: 'checkbox', checked, 'aria-label': label || 'Toggle'});
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', {class: 'switch'}, input, h('span'));
}

/* Desktop notification when a long task finishes while the panel is in the background. */
function notify(title, body = '', {force = false} = {}) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted' || (!document.hidden && !force)) return;
    const n = new Notification(title, {body, icon: '/static/icons/icon-192.png', tag: title});
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* not available */ }
}

function toast(msg, type = 'info', {detail, action, timeout} = {}) {
  const box = $('#toasts');
  const el = h('div', {class: `toast ${type}`, role: type === 'err' ? 'alert' : 'status'},
    icon(type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'info'),
    h('div', {class: 'toast-text'}, h('div', {class: 'toast-msg'}, msg),
      detail && h('div', {class: 'toast-detail'}, String(detail).length > 600 ? String(detail).slice(0, 600) + '…' : String(detail)),
      action && h('div', {style: {marginTop: '6px'}}, h('button', {class: 'btn sm', type: 'button', onclick: () => { dismiss(); action.fn(); }}, action.label))),
    h('button', {class: 'toast-x', type: 'button', title: 'Dismiss', onclick: () => dismiss()}, icon('x')));
  box.append(el);
  while (box.children.length > 5) box.firstChild.remove();
  let t = setTimeout(dismiss, timeout ?? (type === 'err' ? 10000 : 4500));
  el.addEventListener('mouseenter', () => clearTimeout(t));
  el.addEventListener('mouseleave', () => { t = setTimeout(dismiss, 2500); });
  function dismiss() { clearTimeout(t); el.classList.add('out'); setTimeout(() => el.remove(), 200); }
  return dismiss;
}

function modal({title, body, actions, size = '', onClose}) {
  const overlay = h('div', {class: 'modal-overlay'});
  const closeBtn = iconBtn('x', 'Close', () => close(), {kind: 'ghost'});
  const box = h('div', {class: `modal ${size}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-label': title},
    h('header', {class: 'modal-head'}, h('h3', {}, title), closeBtn),
    h('div', {class: 'modal-body'}, body),
    actions && actions.length ? h('footer', {class: 'modal-foot'}, actions) : null);
  overlay.append(box);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  const onKey = e => { if (e.key === 'Escape' && $('#modal-root').lastElementChild === overlay) { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey);
  $('#modal-root').append(overlay);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  }
  return {close, el: box, body: box.querySelector('.modal-body'), setTitle: t => { box.querySelector('h3').textContent = t; }};
}

function confirmDialog({title, message, confirmLabel = 'Confirm', danger = false}) {
  return new Promise(resolve => {
    let done = false;
    const ok = h('button', {class: `btn ${danger ? 'danger solid' : 'primary'}`, type: 'button', onclick: () => { done = true; m.close(); resolve(true); }}, confirmLabel);
    const m = modal({title, body: typeof message === 'string' ? h('p', {}, message) : message,
      actions: [h('button', {class: 'btn ghost', type: 'button', onclick: () => m.close()}, 'Cancel'), ok],
      onClose: () => { if (!done) resolve(false); }});
    setTimeout(() => ok.focus(), 30);
  });
}

/* Fields: {name, label, type: text|textarea|password|number|checkbox|select|time, value, placeholder, required, maxlength, hint, options, validate, rows} */
function formDialog({title, intro, fields, submitLabel = 'Save', danger = false, size = ''}) {
  return new Promise(resolve => {
    let done = false;
    const formId = 'f' + uid();
    const inputs = {};
    const form = h('form', {class: 'form', id: formId, novalidate: true});
    if (intro) form.append(typeof intro === 'string' ? h('p', {class: 'muted'}, intro) : intro);
    for (const f of fields) {
      const id = `${formId}-${f.name}`;
      let input;
      if (f.type === 'textarea') input = h('textarea', {id, class: 'input', rows: f.rows || 4, placeholder: f.placeholder, maxlength: f.maxlength, spellcheck: f.spellcheck ?? true});
      else if (f.type === 'checkbox') input = h('input', {id, type: 'checkbox', checked: !!f.value});
      else if (f.type === 'select') input = h('select', {id, class: 'input'}, f.options.map(o => typeof o === 'object' ? h('option', {value: o.value, selected: o.value === f.value}, o.label) : h('option', {value: o, selected: o === f.value}, o)));
      else input = h('input', {id, class: 'input', type: f.type || 'text', placeholder: f.placeholder, min: f.min, max: f.max, step: f.step, maxlength: f.maxlength, autocomplete: f.autocomplete || 'off', spellcheck: 'false'});
      if (f.type !== 'checkbox' && f.type !== 'select' && f.value !== undefined && f.value !== null) input.value = f.value;
      inputs[f.name] = input;
      if (f.type === 'checkbox') {
        form.append(h('label', {class: 'check', for: id}, input, h('span', {}, h('span', {}, f.label), f.hint && h('small', {class: 'muted'}, f.hint))));
      } else {
        const counter = f.maxlength ? h('span', {class: 'counter'}) : null;
        if (counter) { const upd = () => { counter.textContent = `${input.value.length} / ${f.maxlength}`; }; input.addEventListener('input', upd); upd(); }
        form.append(h('div', {class: 'field'}, h('label', {for: id}, f.label, counter), input, f.hint && h('small', {class: 'hint'}, f.hint), h('small', {class: 'field-error', hidden: true})));
      }
    }
    const submit = h('button', {class: `btn ${danger ? 'danger solid' : 'primary'}`, type: 'submit', form: formId}, submitLabel);
    const m = modal({title, body: form, size, actions: [h('button', {class: 'btn ghost', type: 'button', onclick: () => m.close()}, 'Cancel'), submit],
      onClose: () => { if (!done) resolve(null); }});
    form.addEventListener('submit', e => {
      e.preventDefault();
      const values = {};
      let ok = true;
      for (const f of fields) {
        const inp = inputs[f.name];
        let v = f.type === 'checkbox' ? inp.checked : f.type === 'number' ? (inp.value === '' ? '' : Number(inp.value)) : (f.type === 'password' ? inp.value : inp.value.trim());
        let err = '';
        if (f.required && (v === '' || v === null)) err = 'This field is required.';
        else if (f.validate) err = f.validate(v, values) || '';
        const errEl = inp.closest('.field')?.querySelector('.field-error');
        if (errEl) { errEl.textContent = err; errEl.hidden = !err; }
        if (err) ok = false;
        values[f.name] = v;
      }
      if (!ok) return;
      done = true;
      m.close();
      resolve(values);
    });
    setTimeout(() => form.querySelector('input:not([type=checkbox]),textarea,select')?.focus(), 40);
  });
}

function menuButton(items, {ic = 'more', label, title = 'More actions'} = {}) {
  const b = h('button', {class: `btn sm ghost ${label ? '' : 'icon-only'}`, type: 'button', title, 'aria-haspopup': 'menu'}, icon(ic), label && h('span', {}, label));
  b.addEventListener('click', e => { e.stopPropagation(); openMenu(b, items.filter(Boolean)); });
  return b;
}
function openMenu(anchor, items) {
  closeMenu();
  const m = h('div', {class: 'menu', role: 'menu'}, items.map(it => h('button', {type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '',
    onclick: e => { e.stopPropagation(); closeMenu(); Promise.resolve(it.fn()).catch(err => toast(err.message, 'err')); }}, icon(it.icon || 'chevron'), it.label)));
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = `${clamp(r.right - m.offsetWidth, 8, innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${r.bottom + 4 + m.offsetHeight > innerHeight ? Math.max(8, r.top - m.offsetHeight - 4) : r.bottom + 4}px`;
  S.menu = m;
  setTimeout(() => document.addEventListener('click', closeMenu, {once: true}), 0);
}
function closeMenu() { if (S.menu) { S.menu.remove(); S.menu = null; } }

/* =========================================================================
   Activity log
   ========================================================================= */
const Activity = {
  items: [], errors: 0, open: false, seq: 0,
  add(e) {
    e.id = ++this.seq;
    e.time = new Date();
    this.items.unshift(e);
    if (this.items.length > 400) this.items.length = 400;
    if (e.ok === false) this.errors++;
    renderActivityBadge();
    if (this.open) renderActivity();
    return e;
  },
  update(e, patch) { Object.assign(e, patch); if (patch.ok === false) this.errors++; renderActivityBadge(); if (this.open) renderActivity(); },
};
function renderActivityBadge() {
  const c = $('#activity-count');
  if (!c) return;
  c.hidden = !Activity.errors;
  c.textContent = String(Activity.errors);
}
function renderActivity() {
  const list = clear($('#activity-list'));
  if (!Activity.items.length) { list.append(emptyState('list', 'Nothing yet', 'Actions you take on this page show up here.')); return; }
  for (const e of Activity.items) {
    const cls = e.ok === null || e.ok === undefined ? 'run' : e.ok ? 'ok' : 'err';
    const detail = h('pre', {hidden: true}, [e.cmd && e.cmd !== e.label ? `${e.cmd}\n\n` : '', e.detail || '(no output)'].join(''));
    const meta = [e.time.toLocaleTimeString(), e.kind === 'cli' ? 'CLI' : e.kind === 'term' ? 'terminal' : e.kind === 'chat' ? 'chat' : 'device API',
      e.duration != null ? `${Number(e.duration).toFixed(2)} s` : '', e.status != null && e.ok === false ? `status ${e.status}` : ''].filter(Boolean).join(' · ');
    list.append(h('div', {class: `act ${cls}`},
      h('button', {type: 'button', onclick: () => { detail.hidden = !detail.hidden; }}, h('span', {class: 'st'}), h('span', {class: 'what'}, h('code', {}, e.label), h('small', {}, meta))),
      detail));
  }
}
function toggleActivity(open = !Activity.open) {
  Activity.open = open;
  $('#activity').hidden = !open;
  if (open) { Activity.errors = 0; renderActivityBadge(); renderActivity(); }
}

/* =========================================================================
   Terminal sessions (interactive tiiny commands in a real PTY)
   ========================================================================= */
const Terms = new Map();

async function openTerminal({args, line, title, hint, onExit, autoClose = false}) {
  if (S.health?.remote) {
    toast('Terminals only open on the computer running the panel', 'info', {detail: 'For safety, phones can’t run tiiny commands. Do this on the computer.'});
    return null;
  }
  if (S.health && !S.health.cli.found) {
    toast('The tiiny CLI isn’t installed', 'err', {detail: 'Install it from System → Tiiny CLI, then reload this page.'});
    return null;
  }
  let info;
  try { info = await api('/api/pty', {method: 'POST', body: {args, line, cols: 100, rows: 28}}); }
  catch (e) { toast('Couldn’t start the command', 'err', {detail: e.message}); return null; }
  const s = {id: info.id, title: title || info.cmd, cmd: info.cmd, hint, running: true, code: null, offset: 0, onExit, autoClose,
    links: [], tail: '', decoder: new TextDecoder(), inbuf: '', sending: false};
  s.act = Activity.add({kind: 'term', label: info.cmd, cmd: info.cmd, ok: null, detail: 'Running in a terminal window'});
  Terms.set(s.id, s);
  buildTerminal(s);
  showTerminal(s);
  connectTerminal(s);
  renderTermsButton();
  return s;
}

function buildTerminal(s) {
  const state = h('span', {class: 'term-state'}, 'Running');
  const links = h('div', {class: 'term-links', hidden: true});
  const body = h('div', {class: 'term-body'});
  const stop = h('button', {class: 'btn sm', type: 'button', title: 'Stop the command', onclick: () => killTerminal(s)}, icon('stop'), h('span', {}, 'Stop'));
  const modalEl = h('div', {class: 'term-modal', role: 'dialog', 'aria-label': s.title},
    h('div', {class: 'term-head'}, icon('terminal'),
      h('div', {class: 'title'}, h('strong', {}, s.title), h('code', {}, s.cmd)),
      state, stop,
      h('button', {class: 'btn sm ghost icon-only', type: 'button', title: 'Hide (keeps running)', onclick: () => hideTerminal(s)}, icon('minus')),
      h('button', {class: 'btn sm ghost icon-only', type: 'button', title: 'Close', onclick: () => closeTerminal(s)}, icon('x'))),
    h('div', {class: 'term-hint'}, s.hint || 'This is the real tiiny CLI. Type straight into it: use the arrow keys and Enter for menus. Passwords stay hidden.'),
    links, body);
  const overlay = h('div', {class: 'term-overlay', hidden: true}, modalEl);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) hideTerminal(s); });
  $('#term-root').append(overlay);
  Object.assign(s, {overlay, state, linksEl: links, body, stopBtn: stop});

  if (window.Terminal) {
    const term = new window.Terminal({cursorBlink: true, fontSize: 13, scrollback: 5000,
      fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace',
      theme: {background: '#0d1017', foreground: '#e6e8ee', cursor: '#9fb4ff', selectionBackground: '#33415c'}});
    s.term = term;
    if (window.FitAddon && window.FitAddon.FitAddon) { s.fit = new window.FitAddon.FitAddon(); term.loadAddon(s.fit); }
    term.open(body);
    term.onData(d => sendTermInput(s, d));
    term.onResize(({cols, rows}) => resizeTerm(s, cols, rows));
  } else {
    buildFallbackTerminal(s);
  }
}

function buildFallbackTerminal(s) {
  s.body.className = 'term-fallback';
  s.screen = [''];
  const pre = h('pre');
  const input = h('input', {placeholder: 'Type your answer and press Enter', autocomplete: 'off', spellcheck: 'false'});
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendTermInput(s, input.value + '\r'); input.value = ''; } });
  const keys = [['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['Enter', '\r'], ['Tab', '\t'], ['Esc', '\x1b'], ['Ctrl+C', '\x03'], ['y', 'y'], ['n', 'n']];
  const hide = h('label', {style: {display: 'inline-flex', gap: '5px', alignItems: 'center', color: '#9aa3b5', fontSize: '12px'}},
    h('input', {type: 'checkbox', onchange: e => { input.type = e.target.checked ? 'password' : 'text'; }}), 'hide typing');
  s.body.append(pre, h('div', {class: 'term-input'}, input, keys.map(([label, seq]) => h('button', {type: 'button', onclick: () => sendTermInput(s, seq)}, label)), hide));
  s.fallbackPre = pre;
  s.fallbackInput = input;
}

function renderFallback(s, text) {
  for (const seq of text.split(/(\x1b\[[0-?]*[ -/]*[@-~]|\r\n|\r|\n|\x08)/)) {
    if (!seq) continue;
    const last = s.screen.length - 1;
    if (seq === '\n' || seq === '\r\n') s.screen.push('');
    else if (seq === '\r') s.screen[last] = '';
    else if (seq === '\x08') s.screen[last] = s.screen[last].slice(0, -1);
    else if (seq.startsWith('\x1b[')) {
      if (/^\x1b\[[23]?J$/.test(seq)) s.screen = [''];
      else if (/^\x1b\[\d*A$/.test(seq)) { const n = Number(seq.slice(2, -1)) || 1; s.screen.splice(Math.max(1, s.screen.length - n)); s.screen.push(''); }
      else if (/^\x1b\[[0-2]?K$/.test(seq)) s.screen[last] = '';
    } else s.screen[last] += stripAnsi(seq);
  }
  if (s.screen.length > 3000) s.screen = s.screen.slice(-3000);
  s.fallbackPre.textContent = s.screen.join('\n');
  s.fallbackPre.scrollTop = s.fallbackPre.scrollHeight;
}

function b64bytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function connectTerminal(s) {
  if (s.es) s.es.close();
  const es = new EventSource(`/api/pty/${s.id}/stream?token=${encodeURIComponent(TOKEN)}&offset=${s.offset}`);
  s.es = es;
  es.addEventListener('out', e => {
    const d = JSON.parse(e.data);
    s.offset = d.o;
    const bytes = b64bytes(d.d);
    const text = s.decoder.decode(bytes, {stream: true});
    if (s.term) s.term.write(bytes); else renderFallback(s, text);
    scanLinks(s, text);
  });
  es.addEventListener('exit', e => {
    const d = JSON.parse(e.data);
    es.close();
    if (s.es === es) s.es = null;
    finishTerminal(s, d.code);
  });
  es.onerror = () => {
    if (s.es !== es) return;
    es.close();
    s.es = null;
    if (s.running) setTimeout(() => { if (s.running && Terms.has(s.id) && !s.es) connectTerminal(s); }, 1500);
  };
}

function scanLinks(s, text) {
  s.tail = (s.tail + stripAnsi(text)).slice(-6000);
  const found = s.tail.match(/https?:\/\/[^\s"'<>`\x00-\x1f]+/g) || [];
  let changed = false;
  for (let url of found) {
    url = url.replace(/[).,;\]]+$/, '');
    if (url.length > 12 && !s.links.includes(url)) { s.links.unshift(url); changed = true; }
  }
  if (!changed) return;
  s.links = s.links.slice(0, 5);
  clear(s.linksEl).hidden = false;
  append(s.linksEl, [h('span', {style: {color: '#9aa3b5', fontSize: '12px', alignSelf: 'center'}}, 'Links:'),
    s.links.map(u => h('a', {href: u, target: '_blank', rel: 'noopener noreferrer', title: u}, u))]);
}

function finishTerminal(s, code) {
  s.running = false;
  s.code = code;
  s.state.textContent = code === 0 ? 'Finished' : `Exited (${code ?? '?'})`;
  s.state.className = `term-state ${code === 0 ? 'ok' : 'err'}`;
  s.stopBtn.hidden = true;
  Activity.update(s.act, {ok: code === 0, status: code, detail: code === 0 ? 'Finished' : `Exited with code ${code}`});
  renderTermsButton();
  try { if (s.onExit) s.onExit(code); } catch (e) { console.error(e); }
  if (s.autoClose && code === 0) setTimeout(() => closeTerminal(s, true), 900);
}

function sendTermInput(s, data) {
  if (!s.running) return;
  s.inbuf += data;
  if (s.sending) return;
  s.sending = true;
  (async () => {
    while (s.inbuf && s.running) {
      const chunk = s.inbuf;
      s.inbuf = '';
      try { await api(`/api/pty/${s.id}/input`, {method: 'POST', body: {data: chunk}}); } catch { /* finished */ }
    }
    s.sending = false;
  })();
}

const resizeTimers = new Map();
function resizeTerm(s, cols, rows) {
  clearTimeout(resizeTimers.get(s.id));
  resizeTimers.set(s.id, setTimeout(() => { if (s.running) api(`/api/pty/${s.id}/resize`, {method: 'POST', body: {cols, rows}}).catch(() => {}); }, 120));
}

function showTerminal(s) {
  for (const other of Terms.values()) if (other !== s) other.overlay.hidden = true;
  s.overlay.hidden = false;
  requestAnimationFrame(() => {
    try { if (s.fit) s.fit.fit(); } catch { /* not visible yet */ }
    if (s.term) s.term.focus(); else if (s.fallbackInput) s.fallbackInput.focus();
  });
}
function hideTerminal(s) {
  s.overlay.hidden = true;
  if (s.running) toast('The command keeps running', 'info', {detail: 'Reopen it from Terminals at the top of the page.', timeout: 3500});
  renderTermsButton();
}
async function killTerminal(s) {
  try { await api(`/api/pty/${s.id}/kill`, {method: 'POST', body: {}}); } catch (e) { toast(e.message, 'err'); }
}
async function closeTerminal(s, force = false) {
  if (s.running && !force) {
    const ok = await confirmDialog({title: 'Stop this command?', message: `“${s.cmd}” is still running. Closing the window stops it.`, confirmLabel: 'Stop and close', danger: true});
    if (!ok) return;
    await killTerminal(s);
  }
  if (s.es) s.es.close();
  if (s.term) s.term.dispose();
  s.overlay.remove();
  Terms.delete(s.id);
  renderTermsButton();
}
function renderTermsButton() {
  const b = $('#terms-btn');
  const running = [...Terms.values()].filter(t => t.running).length;
  b.hidden = Terms.size === 0;
  $('#terms-count').textContent = String(running || Terms.size);
}
function termsMenu() {
  const items = [...Terms.values()].reverse().map(s => ({label: `${s.running ? '● ' : ''}${s.title}`, icon: 'terminal', fn: () => showTerminal(s)}));
  if (items.length) openMenu($('#terms-btn'), items);
}
window.addEventListener('resize', debounce(() => {
  for (const s of Terms.values()) if (!s.overlay.hidden && s.fit) { try { s.fit.fit(); } catch { /* ignore */ } }
}, 150));

/* =========================================================================
   Device state: status, models, loading
   ========================================================================= */
const TYPES = {
  chat: m => /^(text generation|image-text-to-text)$/i.test(m?.type || ''),
  embed: m => /embed/i.test(m?.type || ''),
  rerank: m => /rerank/i.test(m?.type || ''),
  asr: m => /^asr$|speech recognition|speech-to-text/i.test(m?.type || ''),
  tts: m => /text-to-speech|tts/i.test(m?.type || ''),
  image: m => /text-to-image/i.test(m?.type || ''),
  ocr: m => /image-to-text|ocr/i.test(m?.type || ''),
  music: m => /music/i.test(m?.type || ''),
  model3d: m => /3d/i.test(m?.type || ''),
  video: m => /video/i.test(m?.type || ''),
  decide: m => /classification/i.test(m?.type || '') || (m?.capabilities || []).includes('systemone'),   // KnowLine, d3: /v1/systemone
};
const isVision = m => TYPES.chat(m) && /image/i.test(m?.input || '');
const TYPE_LABEL = {chat: 'chat', embed: 'embedding', rerank: 'reranking', asr: 'speech recognition', tts: 'text-to-speech', image: 'image generation', ocr: 'OCR',
  music: 'music', model3d: 'image-to-3D', video: 'video', decide: 'decision'};

function setRunning(json) {
  const ids = (json?.data || []).map(m => m.id).filter(Boolean);
  const before = [...S.running].sort().join('|');
  S.running = new Set(ids);
  if (before !== ids.slice().sort().join('|')) emit('running');
}

async function refreshHealth() {
  try { S.health = await api('/api/health'); }
  catch (e) { S.health = null; S.state = 'server'; updatePill(); return null; }
  updatePill();
  return S.health;
}

async function refreshOverview() {
  let o = null;
  try { o = await api('/api/overview'); } catch { /* server gone */ }
  S.overview = o;
  if (o) {
    if (o.running?.ok) setRunning(o.running.json);
    setBorrowed(o.borrowed);
    const usedMb = num(o.npu?.json?.devices?.[0]?.mem_used_mb);
    if (S.running.size === 1 && usedMb && S.modelsAt && !S.loading.size) {
      const only = [...S.running][0];
      if (!num(S.modelsById.get(only)?.npu_usage) && !num(npuFootprints()[only])) recordFootprint(only, usedMb);
    }
    S.deviceId = o.account?.json?.device_id || o.device?.json?.device_id || S.deviceId;
  }
  const prev = S.state;
  S.state = computeState(o);
  S.stateSince = S.state === prev && S.stateSince ? S.stateSince : Date.now();
  // Back from a restart, a lock or start-up: the model list fetched meanwhile failed, so fetch it again.
  if (S.state === 'online' && ['locked', 'starting', 'offline', 'login'].includes(prev)) refreshModels();
  updatePill();
  emit('overview');
  return o;
}

/* The device's gateway answers 502/503 while the services behind it are stopped or still starting. */
const GATEWAY_DOWN = new Set([502, 503]);

function computeState(o) {
  if (!o) return 'server';
  if (!o.conn?.address) return 'setup';
  if (!o.device?.ok && !o.sys?.ok && !o.running?.ok) return 'offline';
  // After any restart or power cut the Tiiny keeps its data (and the services that use it) locked until someone logs in.
  if (o.account?.json?.data_state === 'locked') return 'locked';
  if ([o.sys?.status, o.running?.status, o.npu?.status].includes(401) || !o.conn.key_set) return 'login';
  if (GATEWAY_DOWN.has(o.sys?.status) && GATEWAY_DOWN.has(o.running?.status)) return 'starting';
  return 'online';
}

/* Dashboard cards say this instead of repeating the device's error while it is locked or starting. */
function stateNote() {
  if (S.state === 'locked') return h('p', {class: 'muted'}, 'Shows up once you log in and unlock your Tiiny.');
  if (S.state === 'starting') return h('p', {class: 'muted'}, 'Waiting for your Tiiny to finish starting…');
  return null;
}

function updatePill() {
  const pill = $('#device-pill');
  const text = pill.querySelector('.pill-text');
  const n = S.running.size;
  const labels = {
    online: [`${S.overview?.device?.json?.device_name || 'Connected'} · ${n} loaded`, 'online'],
    login: ['Log in required', 'warn'], setup: ['No device set up', 'warn'],
    locked: ['Locked · log in to unlock', 'warn'], starting: ['Starting up…', 'warn'],
    offline: ['Device offline', 'offline'], server: ['Panel server stopped', 'offline'], unknown: ['Checking…', ''],
  };
  const [label, cls] = labels[S.state] || labels.unknown;
  text.textContent = label;
  pill.className = `pill ${cls}`;
  pill.title = S.overview?.conn?.address ? `Device ${S.overview.conn.address}` : 'Device status';
  // The phone layout's top bar: just the dot while all is well, a word when something needs you.
  const mini = $('#device-pill-mini');
  if (mini) {
    const short = {login: 'Log in', locked: 'Locked', starting: 'Starting', offline: 'Offline', setup: 'Set up', server: 'Stopped'}[S.state] || '';
    mini.className = `pill mini ${cls}`;
    mini.querySelector('.pill-text').textContent = short;
    mini.title = label;
    mini.setAttribute('aria-label', `Device: ${label}`);
  }
}

/* Phones and narrow windows: the sidebar becomes a menu that slides in from the left. */
function setupNavDrawer() {
  const root = document.documentElement, toggle = $('#nav-toggle');
  const set = open => {
    if (root.classList.contains('nav-open') === open) return;
    root.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open) ($('#nav a.active') || $('#nav a'))?.focus({preventScroll: true});
    else if (document.activeElement && $('#sidebar').contains(document.activeElement)) toggle.focus({preventScroll: true});
  };
  toggle.addEventListener('click', () => set(!root.classList.contains('nav-open')));
  $('#nav-backdrop').addEventListener('click', () => set(false));
  $('#sidebar').addEventListener('click', e => { if (e.target.closest('a, .pill')) set(false); });
  $('#device-pill-mini').addEventListener('click', () => go('dashboard'));
  window.addEventListener('hashchange', () => set(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') set(false); });
  window.matchMedia?.('(min-width: 861px)').addEventListener?.('change', e => { if (e.matches) set(false); });
}

async function refreshModels() {
  const r = await dev('/api/v1/models/', {quiet: true, silent: true, timeout: 30});
  if (r.ok) {
    S.models = (r.json?.data || []).filter(m => m && m.id);
    S.modelsById = new Map(S.models.map(m => [m.id, m]));
    S.modelsAt = Date.now();
    S.modelsError = '';
  } else {
    S.modelsError = r.error || 'Could not list models';
  }
  emit('models');
  return r;
}
async function refreshRunning() {
  const r = await dev('/v1/models', {quiet: true, silent: true});
  if (r.ok) setRunning(r.json);
  return r;
}
async function refreshStore() {
  const r = await dev('/api/v1/models/online_models', {quiet: true, silent: true, timeout: 30});
  if (r.ok) {
    S.store = Array.isArray(r.json) ? r.json : (findArray(r.json) || []);
    S.storeById = new Map(S.store.map(m => [m.fullname || m.model_id || m.id, m]));
  } else if (!S.store) S.store = null;
  emit('store');
  return r;
}
/* Download states: such a model is on the device's list but can't be loaded yet. */
const DL_BUSY = /^(downloading|queued|pending|paused|waiting|preparing|converting|importing|verifying|extracting)$/i;
const modelsOf = kind => S.models.filter(m => TYPES[kind](m) && !DL_BUSY.test(m.status || ''));

/* ---- NPU memory: does a model fit next to the loaded ones? ---- */
const LAST_USED = new Map();
function markUsed(id) { if (id && id !== 'default') LAST_USED.set(id, Date.now()); }
/* Each model's share of NPU memory, in %. The device lists one for most models, but some (image models)
   come with 0. For those the panel uses what it measured when it loaded them (kept in the panel settings,
   so every browser shares it), or else an estimate from the model's size on disk. */
const npuTotalMb = () => num(S.overview?.npu?.json?.devices?.[0]?.mem_total_mb) || 49024;   // the Tiiny's 48 GB NPU, if the device doesn't say
const npuFootprints = () => S.health?.settings?.npu_footprints || {};
function npuShareInfo(id) {
  const m = S.modelsById.get(id);
  const listed = num(m?.npu_usage);
  if (listed) return {pct: listed, source: 'listed'};
  const sizeMb = (num(m?.size) || 0) / 1048576;
  const estimate = sizeMb ? Math.round(sizeMb * 1.5 / npuTotalMb() * 100) : 0;
  const measured = Math.round((num(npuFootprints()[id]) || 0) / npuTotalMb() * 100);
  if (measured) return {pct: Math.min(100, Math.max(measured, estimate)), source: 'measured'};
  return {pct: Math.min(100, estimate), source: estimate ? 'estimated' : 'unknown'};
}
const npuShare = id => npuShareInfo(id).pct;
function fitCheck(id) {
  const need = npuShare(id);
  const used = [...S.running].filter(r => r !== id).reduce((a, r) => a + npuShare(r), 0);
  return {need, used, free: Math.max(0, 100 - used), fits: !need || used + need <= 100};
}

/* Remember how much NPU memory a model really took (only for models the device lists as 0%). */
async function recordFootprint(id, mb) {
  if (num(S.modelsById.get(id)?.npu_usage) || !(mb > 256)) return;
  const cur = npuFootprints();
  if (Math.abs((num(cur[id]) || 0) - mb) < 256) return;
  try { await api('/api/settings', {method: 'POST', body: {npu_footprints: {...cur, [id]: Math.round(mb)}}}); await refreshHealth(); }
  catch { /* only an optimisation */ }
}
async function npuUsedMb() {
  const r = await dev('/api/v1/npu/status', {quiet: true, silent: true, timeout: 15});
  if (!r.ok) return null;
  const d0 = r.json?.devices?.[0];
  return d0 ? num(d0.mem_used_mb) : (S.running.size ? null : 0);   // the device lists no NPU while nothing is loaded
}

/* Ask which loaded models to unload so `id` fits. Resolves true to go ahead, false to cancel. */
async function makeRoomFor(id, {force = false, reason = '', protect = new Set()} = {}) {
  // The panel server's plan (tiinyui/npu.py) knows the card's real free memory and what's busy right now.
  let sp = null;
  try { sp = await api(`/api/npu/plan?model=${encodeURIComponent(id)}&protect=${encodeURIComponent([...protect].join(','))}`); } catch { sp = null; }
  if (sp?.error) sp = null;
  const {need, used, fits} = fitCheck(id);
  if ((sp ? sp.fits : fits) && !force) return true;
  const keep = new Set(S.health?.settings?.keep_loaded || []);
  const loaded = [...S.running].filter(r => r !== id && !protect.has(r)).map(r => ({id: r, share: npuShare(r), last: LAST_USED.get(r) || 0, keep: keep.has(r)}))
    .sort((a, b) => a.last - b.last);
  if (!loaded.length) return !protect.size;
  let free = 100 - used;
  const suggest = new Set((sp?.unload || []).filter(x => loaded.some(m => m.id === x)));
  if (!suggest.size) for (const m of loaded) { if (free >= need) break; if (m.keep) continue; suggest.add(m.id); free += m.share; }
  if (force && !suggest.size && loaded.length) suggest.add(loaded.find(m => !m.keep)?.id || loaded[0].id);
  return new Promise(resolve => {
    let done = false;
    const checks = new Map();
    const total = h('strong');
    const bar = progressBar(0);
    const update = () => {
      const after = used - loaded.filter(m => checks.get(m.id).checked).reduce((a, m) => a + m.share, 0) + need;
      total.textContent = `${Math.round(after)}% of the NPU after loading`;
      bar.className = `bar ${after > 100 ? 'err' : after > 85 ? 'warn' : 'ok'}`;
      bar.firstChild.style.width = `${clamp(after, 0, 100)}%`;
    };
    const rows = loaded.map(m => {
      const c = h('input', {type: 'checkbox', checked: suggest.has(m.id), onchange: update});
      checks.set(m.id, c);
      return h('label', {class: 'check'}, c, h('span', {}, h('span', {}, `${shortName(m.id)}  ·  ${m.share}% of the NPU`),
        h('small', {class: 'muted'}, m.keep ? 'Marked “keep loaded”' : m.last ? `Last used ${fmtAgo(m.last)}` : 'Not used from this panel yet')));
    });
    const go = (unload) => async () => {
      done = true;
      md.close();
      for (const m of loaded) if (unload && checks.get(m.id).checked) await unloadModel(m.id);
      resolve(true);
    };
    const md = modal({title: `Make room for ${shortName(id)}?`, onClose: () => { if (!done) resolve(false); },
      body: h('div', {class: 'stack'},
        h('p', {}, reason || `${shortName(id)} needs about ${need}% of the NPU, but loaded models already use about ${Math.round(used)}%. Unload some of them first:`),
        h('div', {class: 'stack-sm'}, rows), h('div', {class: 'stack-sm'}, total, bar),
        protect.size ? h('p', {class: 'muted small'}, `${[...protect].filter(r => S.running.has(r)).map(shortName).join(', ')} stays loaded: this chat is running on it.`) : null,
        h('p', {class: 'muted small'}, 'Shares come from each model’s details in the model store, or from what the panel measured when it last loaded the model; the device has the final say.')),
      actions: [h('button', {class: 'btn ghost', type: 'button', onclick: () => md.close()}, 'Cancel'),
        h('button', {class: 'btn', type: 'button', onclick: go(false)}, 'Load anyway'),
        h('button', {class: 'btn primary', type: 'button', onclick: go(true)}, 'Unload selected and load')]});
    update();
  });
}

/* Models 🎤 and 🔊 load just for themselves are borrowed (voice.js): the panel server unloads them again once they're
   done with them and nothing else has used them for a while (tiinyui/common.py, Borrowed). Loading such a model for
   anything else (borrow: false, the default) keeps it loaded, as if you had loaded it yourself. */
function setBorrowed(b) {
  const next = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  const changed = Object.keys(next).sort().join('|') !== Object.keys(S.borrowed).sort().join('|');
  S.borrowed = next;
  if (changed) emit('running');
}
async function keepBorrowed(id) {
  if (!S.borrowed[id]) return false;
  try { setBorrowed((await api('/api/models/borrowed', {method: 'POST', body: {model: id, state: 'keep'}})).borrowed); return true; }
  catch { return false; }   // only a convenience: at worst it's unloaded and loads again when next used
}
function borrowedNote(id) {
  const b = S.borrowed[id];
  if (!b) return null;
  const when = b.after ? `${fmtSecs(b.after)} after it was last used` : 'as soon as nothing is using it';
  const who = b.for === 'voice' ? '🎤 or 🔊 in a chat' : b.for;   // or the app that asked for it (Integrations)
  return h('div', {class: 'model-borrowed'}, icon('clock'),
    h('span', {class: 'spacer'}, `Loaded just for ${who}, so it’s unloaded again ${when}.`),
    btn('Keep loaded', async () => { if (await keepBorrowed(id)) toast(`${shortName(id)} stays loaded`, 'ok', {timeout: 2500}); }, {small: true, kind: 'ghost'}));
}

async function loadModel(id, {quiet = false, skipFit = false, protect = new Set(), borrow = false} = {}) {
  if (!borrow) keepBorrowed(id);
  if (S.running.has(id)) { markUsed(id); return true; }
  const existing = S.loading.get(id);
  if (existing) return existing.promise;
  if (!S.modelsAt) await refreshModels();
  if (!skipFit && !(await makeRoomFor(id, {protect}))) return false;
  const meta = S.modelsById.get(id);
  const st = {pct: null, since: Date.now(), expected: meta?.load_time || 0};
  const measure = !num(meta?.npu_usage);
  const run = async () => {
    const before = measure ? {mb: await npuUsedMb(), others: [...S.running].sort().join('|')} : null;
    let r = await dev(`/api/v1/models/${encPath(id)}/start`, {method: 'POST', label: `Load ${shortName(id)}`, timeout: 180, silent: true});
    if (!r.ok && /memory|insufficient|not enough|capacity|resource|exceed|npu/i.test(r.error || '') && S.running.size) {
      if (!(await makeRoomFor(id, {force: true, protect, reason: `The device says there isn’t room for ${shortName(id)}: “${r.error}”. Unload something first:`}))) return false;
      if (before) { before.mb = await npuUsedMb(); before.others = [...S.running].sort().join('|'); }
      r = await dev(`/api/v1/models/${encPath(id)}/start`, {method: 'POST', label: `Load ${shortName(id)}`, timeout: 180, silent: true});
    }
    if (!r.ok) throw new Error(r.error || 'The device refused to load it.');
    const deadline = Date.now() + Math.max(240, (meta?.load_time || 30) * 10) * 1000;
    while (Date.now() < deadline) {
      await sleep(1500);
      const [pr, rn] = await Promise.all([
        dev(`/api/v1/models/${encPath(id)}/get_progress`, {quiet: true, silent: true}),
        dev('/v1/models', {quiet: true, silent: true}),
      ]);
      if (rn.ok) setRunning(rn.json);
      if (S.running.has(id)) {
        if (before && before.mb !== null && [...S.running].filter(x => x !== id).sort().join('|') === before.others) {
          const after = await npuUsedMb();
          if (after !== null) recordFootprint(id, after - before.mb);
        }
        return true;
      }
      const p = pr.ok ? pr.json : null;
      if (p) {
        const status = String(p.status || '');
        if (/fail|error/i.test(status)) throw new Error(p.message || p.error || `The device reported “${status}”.`);
        if (/load|start|init|warm|pending/i.test(status) && num(p.progress) !== null && num(p.progress) < 100) st.pct = num(p.progress);
      }
      emit('loading');
    }
    throw new Error('Loading is taking longer than expected. It may still finish; check the Dashboard.');
  };
  st.promise = (async () => {
    try {
      const ok = await run();
      if (ok) markUsed(id);
      if (ok && !quiet) toast(`${shortName(id)} is loaded and ready`, 'ok');
      if (ok && Date.now() - st.since > 15000) notify(`${shortName(id)} is loaded`, 'Ready to use.');
      return ok;
    } catch (e) {
      toast(`Couldn’t load ${shortName(id)}`, 'err', {detail: e.message});
      return false;
    } finally {
      S.loading.delete(id);
      emit('loading');
      emit('running');
    }
  })();
  S.loading.set(id, st);
  emit('loading');
  return st.promise;
}

async function unloadModel(id) {
  const r = await dev(`/api/v1/models/${encPath(id)}/stop`, {method: 'POST', label: `Unload ${shortName(id)}`, timeout: 120});
  if (r.ok) toast(`${shortName(id)} unloaded`, 'ok');
  await refreshRunning();
  return r.ok;
}
async function unloadAll() {
  if (!S.running.size) { toast('No models are loaded', 'info'); return; }
  const ok = await confirmDialog({title: 'Unload all models?', message: `This frees NPU memory used by ${S.running.size} model(s). Running tasks on them stop.`, confirmLabel: 'Unload all'});
  if (!ok) return;
  const r = await dev('/api/v1/models/unload_all', {method: 'POST', label: 'Unload all models', timeout: 180});
  if (r.ok) toast('All models unloaded', 'ok');
  await refreshRunning();
}
async function interruptModel(id) {
  const r = await dev(`/api/v1/models/${encPath(id)}/interrupt`, {method: 'POST', label: `Interrupt ${shortName(id)}`});
  if (r.ok) toast(`Interrupted the task on ${shortName(id)}`, 'ok');
}
async function interruptAll() {
  const r = await dev('/api/v1/models/interrupt_all', {method: 'POST', label: 'Interrupt all tasks'});
  if (r.ok) toast('Interrupted all running tasks', 'ok');
}
async function deleteModel(id) {
  const m = S.modelsById.get(id);
  const ok = await confirmDialog({title: `Delete ${shortName(id)}?`, danger: true, confirmLabel: 'Delete from device',
    message: h('div', {class: 'stack-sm'}, h('p', {}, `This removes ${id}${m?.total_size ? ` (${fmtBytes(m.total_size, {si: true})})` : ''} from the device.`),
      h('p', {class: 'muted small'}, 'You can download it again from the model store later.'))});
  if (!ok) return false;
  if (S.running.has(id)) await unloadModel(id);
  // silent: the device's own reason is the message (like "Embedding models are protected and cannot be deleted."),
  // not a generic "… failed" with the reason in small print; the Activity log still has the request
  const r = await dev(`/api/v1/models/${encPath(id)}`, {method: 'DELETE', label: `Delete ${shortName(id)}`, timeout: 120, silent: true});
  if (r.ok) toast(`${shortName(id)} deleted`, 'ok');
  else toast(r.error || `Couldn’t delete ${shortName(id)}`, 'err', {detail: `${shortName(id)} is still on your Tiiny.`, timeout: 15000});
  await refreshModels();
  return r.ok;
}
async function benchModel(id) {
  if (!S.running.has(id)) {
    const go = await confirmDialog({title: 'Load the model first?', message: `Benchmarks need ${shortName(id)} loaded in NPU memory.`, confirmLabel: 'Load it'});
    if (!go || !(await loadModel(id))) return;
  }
  const meta = S.modelsById.get(id);
  const v = await formDialog({title: `Benchmark ${shortName(id)}`, submitLabel: 'Run benchmark',
    intro: 'Measures prefill and decode speed on the NPU. It runs the official tiiny bench command in a terminal window.',
    fields: [
      {name: 'sizes', label: 'Token sizes', value: '256,512,1024', hint: 'Comma-separated prompt lengths to test.', validate: v => /^\s*\d+(\s*,\s*\d+)*\s*$/.test(v) ? '' : 'Use numbers separated by commas, e.g. 256,512'},
      meta?.thinking?.supported ? {name: 'think', label: 'Enable thinking', type: 'checkbox', value: false} : null,
    ].filter(Boolean)});
  if (!v) return;
  openTerminal({args: ['bench', id, `--token-sizes=${v.sizes.replace(/\s+/g, '')}`, v.think ? '--think' : null].filter(Boolean), title: `Benchmark ${shortName(id)}`});
}

async function modelDetails(id) {
  const m = S.modelsById.get(id) || S.storeById.get(id) || (S.store || []).find(x => (x.fullname || x.model_id) === id);
  const body = h('div', {class: 'stack'});
  const md = modal({title: m ? (m.display_name || m.name) : id, body, size: 'wide'});
  if (!m) { body.append(h('p', {}, 'No details available for this model.')); return md; }
  const think = m.thinking || {};
  append(body, [
    h('div', {class: 'model-head'}, modelIcon(m), h('div', {class: 'model-title'}, h('strong', {}, m.display_name || m.name), h('span', {class: 'mono'}, m.fullname || m.id || m.model_id)),
      h('div', {class: 'row gap-sm'}, S.running.has(m.id) && badge('Loaded', 'ok', 'check'))),
    h('div', {class: 'model-meta'}, typeBadge(m), m.params && badge(m.params), (m.supported || []).map(s => badge(s)), think.supported && badge(think.toggleable ? 'Thinking: optional' : 'Always thinks', 'accent', 'brain'), m.need_update && badge('Update available', 'warn')),
    kvList([
      ['Model ID', h('span', {class: 'row gap-sm'}, h('code', {}, m.fullname || m.id), iconBtn('copy', 'Copy model ID', () => copyText(m.fullname || m.id, 'Model ID copied')))],
      ['Type', m.type], ['Input → output', m.input && m.output ? `${m.input} → ${m.output}` : null], ['Parameters', m.params],
      ['Size on disk', m.total_size ? fmtBytes(m.total_size, {si: true}) : null],
      ['NPU memory', num(m.npu_usage) !== null ? `${m.npu_usage}% of the NPU` : null],
      ['Load time', m.load_time ? `about ${fmtSecs(m.load_time)}` : null],
      ['Context window', m.context_window ? Number(m.context_window).toLocaleString() + ' tokens' : null],
      ['Thinking levels', (think.levels || []).length ? think.levels.join(', ') + (think.default_level ? ` (default ${think.default_level})` : '') : null],
      ['Version', m.version_label || m.version], ['Source', m.owned_by],
      ['Downloaded', m.downloaded_time ? fmtDate(m.downloaded_time) : null], ['Updated', m.udpate_time ? fmtDate(m.udpate_time) : null],
    ]),
    m.desc && h('div', {class: 'stack-sm'}, h('div', {class: 'section-title'}, 'About this model'), h('div', {class: 'md desc-md', html: renderMarkdown(m.desc)})),
    rawDetails(m, 'All metadata')]);
  return md;
}

function modelIcon(m) {
  const box = h('div', {class: 'model-icon'});
  const src = m?.icon_url;
  if (src && /^\/api\/v1\/models\//.test(src)) {
    const img = h('img', {src: iconHref(src), alt: '', loading: 'lazy'});
    img.addEventListener('error', () => { img.remove(); box.append(icon('box')); });
    box.append(img);
  } else box.append(icon('box'));
  return box;
}
function typeBadge(m) {
  const t = m?.type || 'Model';
  return badge(t, TYPES.chat(m) ? 'accent' : '');
}

/* Downloads in progress (polls while anything downloads). */
const Downloads = {
  list: [], timer: null, watching: new Set(),
  async poll() {
    clearTimeout(this.timer);
    this.timer = null;
    const r = await dev('/api/v1/models/', {service: 'p8800', query: {including_downloading: 'true'}, quiet: true, silent: true, timeout: 30});
    if (r.ok) {
      const all = r.json?.data || [];
      const busy = DL_BUSY;
      const settled = /^(downloaded|not_downloaded|running|loaded|loading|starting|stopped|stopping|ready|error|failed)$/i;
      this.list = all.filter(m => m && (busy.test(m.status || '') || (!settled.test(m.status || '') && num(m.progress) !== null && num(m.progress) < 100)));
      for (const id of [...this.watching]) {
        const m = all.find(x => x.id === id);
        if (m && String(m.status).toLowerCase() === 'downloaded') {
          this.watching.delete(id);
          toast(`${m.display_name || m.name || id} finished downloading`, 'ok');
          refreshModels();
          if (S.store) refreshStore();
        }
      }
    }
    emit('downloads');
    if (this.list.length || this.watching.size) this.timer = setTimeout(() => this.poll(), 2500);
  },
  start(id) { if (id) this.watching.add(id); this.poll(); },
};

async function downloadModel(id) {
  const m = S.storeById.get(id);
  const r = await dev(`/api/v1/models/${encPath(id)}/download`, {method: 'POST', label: `Download ${m?.name || id}`, timeout: 60});
  if (!r.ok) return false;
  toast(`Downloading ${m?.name || id}`, 'ok', {detail: 'Progress shows at the top of the Models page. The device needs Wi-Fi or Ethernet internet access.'});
  Downloads.start(id);
  return true;
}
async function cancelDownload(id, name) {
  const ok = await confirmDialog({title: `Cancel downloading ${name || id}?`, message: 'The partly downloaded files are removed.', confirmLabel: 'Cancel download', danger: true});
  if (!ok) return;
  await Downloads.poll();
  if (!Downloads.list.some(m => m.id === id)) { toast('That download already finished', 'info'); return; }
  const r = await dev(`/api/v1/models/${encPath(id)}`, {service: 'p8800', method: 'DELETE', label: `Cancel download ${name || id}`});
  if (r.ok) toast('Download cancelled', 'ok');
  Downloads.watching.delete(id);
  Downloads.poll();
}

async function importModel() {
  const v = await formDialog({title: 'Import a model from Hugging Face', submitLabel: 'Import', size: 'wide',
    intro: h('div', {class: 'stack-sm'}, h('p', {}, 'Tiiny downloads the repository, converts it, and adds it to your models.'),
      h('p', {class: 'muted small'}, 'Supported: fine-tunes of Qwen3.5-9B and Z-Image-Turbo in safetensors format. The device needs internet access.')),
    fields: [
      {name: 'url', label: 'Hugging Face URL', placeholder: 'https://huggingface.co/your-name/your-model', required: true,
        validate: v => /^https:\/\/huggingface\.co\/[^/\s]+\/[^/\s]+/.test(v) ? '' : 'Paste a model URL like https://huggingface.co/owner/model'},
      {name: 'desc', label: 'Description (optional)', type: 'textarea', rows: 3, maxlength: 3000},
    ]});
  if (!v) return;
  const log = h('div', {class: 'log-box'}, 'Starting import…\n');
  const bar = progressBar(0, {indeterminate: true});
  const status = h('div', {class: 'small muted'}, 'Contacting the device…');
  const controller = new AbortController();
  const m = modal({title: 'Importing model', body: h('div', {class: 'stack'}, status, bar, log), size: 'wide',
    actions: [h('button', {class: 'btn', type: 'button', onclick: () => m.close()}, 'Close')], onClose: () => controller.abort()});
  const line = text => { log.textContent += text + '\n'; log.scrollTop = log.scrollHeight; };
  const handle = raw => {
    let obj = null;
    try { obj = JSON.parse(raw); } catch { /* plain text */ }
    if (obj && typeof obj === 'object') {
      const pct = num(pick(obj, 'progress', 'percent', 'percentage'));
      const msg = pick(obj, 'message', 'msg', 'stage', 'status', 'step');
      if (pct !== null) { bar.classList.remove('indeterminate'); bar.firstChild.style.width = `${clamp(pct, 0, 100)}%`; }
      if (msg) status.textContent = `${msg}${pct !== null ? ` · ${Math.round(pct)}%` : ''}`;
      line(msg ? `${msg}${pct !== null ? ` (${pct}%)` : ''}` : raw);
    } else line(raw);
  };
  try {
    const res = await devStream('/api/v1/models/import', {method: 'POST', json: {hf_url: v.url, model_desc: v.desc || ''}, label: 'Import model', signal: controller.signal},
      (ev, d) => { if (ev === 'line') handle(d.text); else if (ev === 'event') handle(d.data); else if (ev === 'start') status.textContent = 'Importing…'; });
    bar.classList.remove('indeterminate');
    if (res.ok) { bar.firstChild.style.width = '100%'; status.textContent = 'Import finished.'; toast('Model imported', 'ok'); refreshModels(); }
    else { status.textContent = 'Import failed.'; line(`Error: ${res.error}`); bar.classList.add('err'); }
  } catch (e) {
    if (e.name !== 'AbortError') { line(`Error: ${e.message}`); status.textContent = 'Import failed.'; }
  }
}

async function restartDevice() {
  const ok = await confirmDialog({title: 'Restart your Tiiny?', confirmLabel: 'Restart', message: 'Running tasks stop and loaded models are unloaded. The device is back in about a minute.'});
  if (!ok) return;
  const r = await dev('/api/v1/sys/reboot/', {service: 'p8800', method: 'POST', label: 'Restart device'});
  if (r.ok) toast('Restarting…', 'ok', {detail: 'This page reconnects automatically once the device is back.'});
}
async function shutdownDevice() {
  const ok = await confirmDialog({title: 'Shut down your Tiiny?', danger: true, confirmLabel: 'Shut down',
    message: h('div', {class: 'stack-sm'}, h('p', {}, 'Running tasks stop and the device powers off.'), h('p', {}, h('strong', {}, 'Keep the power connected until the indicator light turns off.')))});
  if (!ok) return;
  const r = await dev('/api/v1/sys/shutdown/', {service: 'p8800', method: 'POST', label: 'Shut down device'});
  if (r.ok) toast('Shutting down…', 'ok', {detail: 'Wait for the indicator light to turn off before unplugging.'});
}

function loginTerminal({reason = ''} = {}) {
  return openTerminal({args: ['login'], title: 'Log in to your Tiiny', hint: `${reason ? `${reason} ` : ''}Enter the password you chose when activating the device. It is sent only to the device.`,
    onExit: code => { if (code === 0) { toast('Logged in', 'ok'); refreshHealth(); refreshOverview(); refreshModels(); } }});
}
/* Log in with the Tiiny's password (POST /api/device/login). The password goes only to the Tiiny, and the key it answers
   with is kept in Tiiny's tool's config, like `tiiny login` does. Works with every version of the tool (its 0.0.6 says
   "Already logged in" without getting a key while the Tiiny is unlocked). The terminal stays one click away. */
function loginDialog({reason = '', onDone} = {}) {
  if (S.health?.remote) {
    toast('Log in on a device with full access', 'info', {detail: 'Devices with limited access can’t log in to the Tiiny.'});
    return null;
  }
  const id = 'login-' + uid();
  const user = S.overview?.account?.json?.user_info?.user_name || '';
  const pw = h('input', {id, class: 'input', type: 'password', autocomplete: 'current-password', maxlength: 256, spellcheck: 'false'});
  const err = h('small', {class: 'field-error', role: 'alert', hidden: true});
  const go = h('button', {class: 'btn primary', type: 'submit', form: `${id}-form`}, 'Log in');
  const form = h('form', {class: 'form', id: `${id}-form`, novalidate: true},
    typeof reason === 'string' && reason ? h('p', {class: 'muted'}, reason) : null,
    user ? h('p', {}, 'Account: ', h('strong', {}, user)) : null,
    h('div', {class: 'field'}, h('label', {for: id}, 'Your Tiiny’s password'), pw,
      h('small', {class: 'hint'}, 'The password you chose when you activated your Tiiny. It goes only to your Tiiny, which allows 3 tries before it locks you out for a while.'), err));
  const m = modal({title: 'Log in to your Tiiny', body: form, actions: [
    h('button', {class: 'btn ghost', type: 'button', onclick: () => { m.close(); loginTerminal({reason: typeof reason === 'string' ? reason : ''}); }}, 'Use Tiiny’s tool instead'),
    h('button', {class: 'btn ghost', type: 'button', onclick: () => m.close()}, 'Cancel'), go]});
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!pw.value) { err.textContent = 'Type your Tiiny’s password.'; err.hidden = false; pw.focus(); return; }
    go.disabled = true; err.hidden = true;
    try {
      const r = await api('/api/device/login', {method: 'POST', body: {password: pw.value}});
      pw.value = '';
      m.close();
      toast(r.user ? `Logged in as ${r.user}` : 'Logged in', 'ok', r.data_state === 'locked' ? {detail: 'Your Tiiny is still unlocking. This page checks again by itself.'} : {});
      refreshHealth(); refreshModels();
      refreshOverview().then(() => { if (typeof onDone === 'function') onDone(); });
    } catch (e2) {
      err.textContent = e2.message || 'Couldn’t log in.'; err.hidden = false;
      pw.select(); pw.focus();
    } finally { go.disabled = false; }
  });
  setTimeout(() => pw.focus(), 40);
  return m;
}
function activateTerminal() {
  return openTerminal({args: ['init'], title: 'Activate your Tiiny', hint: 'First-time setup: choose a username and password, and optionally a recovery email.',
    onExit: () => { refreshHealth(); refreshOverview(); }});
}

/* =========================================================================
   Markdown (escaped first, then a small safe subset)
   ========================================================================= */
function mdInline(src, cites) {
  const codes = [];
  let s = String(src).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  if (cites && cites.size) {
    s = s.replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g, (all, list) => {
      const ns = list.split(',').map(x => Number(x.trim()));
      return ns.every(n => cites.has(n)) ? ns.map(n => `<button type="button" class="cite" data-cite="${n}" title="Show source ${n}">${n}</button>`).join('') : all;
    });
  }
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
}
const MD_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/;
const mdIndent = l => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
function renderMarkdown(src, opts = {}) {
  const cites = opts.cites;
  const lines = String(src || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isBlockStart = l => /^\s*(```|~~~)/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || /^\s*([-*+]|\d+[.)])\s+/.test(l) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
      i++;
      out.push(`<div class="code"><div class="code-head"><span>${escapeHtml(fence[2] || 'text')}</span><button type="button" data-copy-code>Copy</button></div><pre><code>${escapeHtml(buf.join('\n'))}</code></pre></div>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) { const lvl = Math.min(hm[1].length + 2, 6); out.push(`<h${lvl}>${mdInline(hm[2], cites)}</h${lvl}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), opts)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map(c => `<th>${mdInline(c, cites)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${mdInline(c, cites)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const lm = line.match(MD_ITEM);
    if (lm) {
      // A list: items at this indent, each with everything indented under it (sub-lists, code, more text).
      // Blank lines between items don't end the list, so "1." … "2." … "3." stays one numbered list.
      const base = mdIndent(line), ordered = /\d/.test(lm[2]);
      const start = ordered ? parseInt(lm[2], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const m2 = lines[i].match(MD_ITEM);
        if (!m2 || mdIndent(lines[i]) !== base || /\d/.test(m2[2]) !== ordered) break;
        const off = m2[1].length + m2[2].length + m2[3].length;
        const body = [m2[4]];
        i++;
        while (i < lines.length) {
          if (!lines[i].trim()) {
            let j = i + 1;
            while (j < lines.length && !lines[j].trim()) j++;
            if (j < lines.length && mdIndent(lines[j]) > base) { body.push(''); i++; continue; }
            break;
          }
          if (mdIndent(lines[i]) <= base) break;
          body.push(lines[i].slice(Math.min(off, mdIndent(lines[i]))));
          i++;
        }
        items.push(body);
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        const next = j < lines.length ? lines[j].match(MD_ITEM) : null;
        if (next && mdIndent(lines[j]) === base && /\d/.test(next[2]) === ordered) i = j; else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const li = body => renderMarkdown(body.join('\n'), opts).replace(/^<p>([\s\S]*?)<\/p>/, '$1');
      out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.map(b => `<li>${li(b)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !(buf.length && isBlockStart(lines[i]))) buf.push(lines[i++]);
    out.push(`<p>${buf.map(l => mdInline(l, cites)).join('<br>')}</p>`);
  }
  return out.join('');
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-copy-code]');
  if (!b) return;
  const code = b.closest('.code')?.querySelector('pre')?.textContent || '';
  copyText(code, 'Code copied');
});

/* =========================================================================
   Router and views
   ========================================================================= */
const VIEWS = [
  {id: 'dashboard', order: 10, group: 'main', title: 'Dashboard', ic: 'gauge', sub: 'Your Tiiny at a glance', render: viewDashboard},
  {id: 'models', order: 20, group: 'main', title: 'Models', ic: 'box', sub: 'Download, load and manage models', render: viewModels},
  {id: 'vault', order: 50, group: 'main', title: 'Vault', ic: 'archive', sub: 'Files the device can search and use as context', render: viewVault},
  {id: 'playground', order: 60, group: 'create', title: 'Playground', ic: 'wand', sub: 'Images, speech, transcription, OCR, embeddings, reranking and decisions', render: viewPlayground},
  {id: 'connectors', order: 80, group: 'device', title: 'Connectors', ic: 'plug', sub: 'Email, calendars, messaging apps and MCP servers', render: viewConnectors},
  {id: 'network', order: 85, group: 'device', title: 'Network', ic: 'wifi', sub: 'Wi-Fi and which device this panel talks to', render: viewNetwork},
  {id: 'account', order: 90, group: 'device', title: 'Account', ic: 'user', sub: 'Login, API key and personalization', render: viewAccount},
  {id: 'terminal', computerOnly: true, order: 100, group: 'tools', title: 'Terminal', ic: 'terminal', sub: 'Run any tiiny command', render: viewTerminal},
  {id: 'system', order: 110, group: 'tools', title: 'System', ic: 'settings', sub: 'Power, firmware, backups and settings', render: viewSystem},
];
/* Feature scripts call this before boot.js runs init(). */
function registerView(v) {
  const i = VIEWS.findIndex(x => x.id === v.id);
  if (i >= 0) VIEWS.splice(i, 1);
  VIEWS.push(v);
  VIEWS.sort((x, y) => (x.order ?? 999) - (y.order ?? 999));
}

function buildNav() {
  const nav = clear($('#nav'));
  let group = null;
  for (const v of VIEWS) {
    if (v.hidden || (v.computerOnly && S.health?.remote)) continue;
    if (group !== null && v.group !== group) nav.append(h('div', {class: 'nav-sep'}));
    group = v.group;
    const dot = v.id === 'system' && S.health?.update?.newer && !S.health?.remote;   // a new version of the panel is out
    nav.append(h('a', {href: `#/${v.id}`, dataset: {view: v.id}, title: dot ? `${v.title}: a new version of the panel is available` : v.title,
      class: v.id === S.view ? 'active' : ''}, icon(v.ic), h('span', {}, v.title), dot ? h('span', {class: 'nav-dot', 'aria-label': 'Update available'}) : null));
  }
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
  return {id: parts[0] || 'dashboard', params: parts.slice(1), query: new URLSearchParams(qs)};
}

let viewCleanup = null;
function route() {
  if ($('#app').classList.contains('signed-out')) return;
  const {id, params, query} = parseHash();
  const v = VIEWS.find(x => x.id === id && !(x.computerOnly && S.health?.remote)) || VIEWS[0];
  if (viewCleanup) { try { viewCleanup(); } catch (e) { console.error(e); } viewCleanup = null; }
  closeMenu();
  S.view = v.id;
  S.dropHandler = null;
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.dataset.view === v.id);
  $('#view-title').textContent = v.title;
  $('#view-sub').textContent = v.sub || '';
  document.title = `${v.title} · Tiiny Control Panel`;
  const root = clear($('#view'));
  root.className = `view view-${v.id}${v.wide ? ' wide' : ''}`;
  const cleanups = [];
  const token = {};
  S.viewToken = token;
  const ctx = {
    root, params, query,
    alive: () => S.viewToken === token,
    onCleanup: fn => cleanups.push(fn),
    every(ms, fn) { const t = setInterval(() => { if (!document.hidden) fn(); }, ms); cleanups.push(() => clearInterval(t)); },
    on(name, fn) { bus.addEventListener(name, fn); cleanups.push(() => bus.removeEventListener(name, fn)); },
    setTitle(title, sub) { $('#view-title').textContent = title; if (sub !== undefined) $('#view-sub').textContent = sub; document.title = `${title} · Tiiny Control Panel`; },
  };
  viewCleanup = () => cleanups.forEach(fn => fn());
  try { v.render(root, ctx); }
  catch (e) { console.error(e); root.append(errorBlock(e.message || String(e), {title: 'This page failed to render'})); }
}
const go = path => { location.hash = `#/${path}`; };

/* ---------------------------------------------------------------- Dashboard */
function viewDashboard(root, ctx) {
  const banner = h('div', {class: 'stack'});
  const devBody = h('div', {}, loadingBlock());
  const resBody = h('div', {}, loadingBlock());
  const loadedBody = h('div', {}, loadingBlock());
  const plannerBox = h('div');
  const now = nowCard(ctx);
  root.append(banner,
    now.el,
    h('div', {class: 'grid cols-2'},
      card({title: 'Device', ic: 'cpu', actions: [iconBtn('refresh', 'Refresh', () => load())]}, devBody),
      card({title: 'Resources', ic: 'gauge', sub: 'Updates every few seconds'}, resBody)),
    card({title: 'Loaded models', ic: 'box', sub: 'In NPU memory and ready to use', actions: [btn('Unload all', unloadAll, {small: true, icon: 'power', kind: 'ghost'}), linkBtn('All models', '#/models', {ic: 'chevron'})]}, h('div', {class: 'stack'}, plannerBox, loadedBody)),
    card({title: 'Quick actions', ic: 'bolt'}, quickActions()),
    typeof historyCard === 'function' ? historyCard(ctx) : null,
    typeof speedCard === 'function' ? speedCard(ctx) : null);
  const renderPlanner = () => { if (typeof npuPlanner === 'function' && S.modelsAt) clear(plannerBox).append(npuPlanner()); };
  ctx.on('running', renderPlanner);
  ctx.on('models', renderPlanner);

  // Every overview refresh redraws it, whoever asked for it: a login or a setting shows at once, not on the next tick.
  function render() {
    if (!ctx.alive()) return;
    const o = S.overview;
    renderBanner(banner, o);
    renderDevice(devBody, o);
    renderResources(resBody, o);
    now.render(o);
    renderLoadedModels(loadedBody);
    renderPlanner();
  }
  ctx.on('overview', render);
  const load = () => refreshOverview();
  load();
  if (!S.modelsAt) refreshModels();
  if (!Downloads.timer) Downloads.poll();  // model downloads show in Right now too
  ctx.every(4000, load);
  ctx.on('models', () => renderLoadedModels(loadedBody));
  ctx.on('running', () => renderLoadedModels(loadedBody));
  ctx.on('loading', () => renderLoadedModels(loadedBody));
}

function quickActions() {
  const q = (title, sub, ic, fn, danger) => {
    const el = h('button', {class: `quick ${danger ? 'danger' : ''}`, type: 'button'}, icon(ic), h('strong', {}, title), h('small', {}, sub));
    el.addEventListener('click', async () => { el.classList.add('busy'); try { await fn(); } finally { el.classList.remove('busy'); } });
    return el;
  };
  return h('div', {class: 'quick-grid'},
    q('Chat', 'Talk to a loaded model', 'chat', () => go('chat')),
    q('Add files to Vault', 'Make documents searchable', 'upload', () => go('vault')),
    q('Get models', 'Browse the model store', 'download', () => { sessionStorage.setItem('tiiny.modelsTab', 'store'); go('models'); }),
    q('Interrupt all tasks', 'Stop running inference', 'stop', interruptAll),
    q('Restart device', 'Back in about a minute', 'rotate', restartDevice),
    q('Shut down', 'Wait for the light to go off', 'power', shutdownDevice, true));
}

function renderBanner(el, o) {
  clear(el);
  const st = S.state;
  if (st === 'server') el.append(errorBlock('The page can’t reach the local panel server. Restart it with python3 tiiny_ui.py, then reload.', {title: 'Panel server stopped'}));
  else if (st === 'setup') {
    el.append(h('div', {class: 'banner info'}, icon('info'), h('div', {class: 'text'}, h('strong', {}, 'Set up your device'),
      h('span', {class: 'small'}, 'Connect your Tiiny over USB-C or put it on your network, then find it here.')),
      btn('Find my Tiiny', () => go('network'), {kind: 'primary', icon: 'scan'})));
  } else if (st === 'offline') {
    el.append(h('div', {class: 'banner err'}, icon('alert'), h('div', {class: 'text'}, h('strong', {}, `Can’t reach your Tiiny at ${o?.conn?.address}`),
      h('span', {class: 'small'}, o?.sys?.error || o?.device?.error || 'Check that it is powered on and on the same network.')),
      btn('Find devices', () => go('network'), {icon: 'scan'})));
  } else if (st === 'locked') {
    el.append(h('div', {class: 'banner warn'}, icon('key'), h('div', {class: 'text'}, h('strong', {}, 'Your Tiiny is locked'),
      h('span', {class: 'small'}, 'It locks its data every time it restarts or loses power. Until you log in, its models, Vault, connectors and monitor don’t run. Log in to unlock it; the rest starts by itself within a minute or two.')),
      btn('Log in', () => loginDialog({reason: 'This unlocks your Tiiny.'}), {kind: 'primary', icon: 'login'})));
  } else if (st === 'starting') {
    const long = Date.now() - (S.stateSince || Date.now()) > 5 * 60_000;
    el.append(h('div', {class: `banner ${long ? 'warn' : 'info'}`}, long ? icon('alert') : h('span', {class: 'spinner'}), h('div', {class: 'text'}, h('strong', {}, long ? 'Your Tiiny’s services still aren’t answering' : 'Your Tiiny is starting up'),
      h('span', {class: 'small'}, long ? 'They usually start within a minute or two of a restart or login. If it stays like this, restart your Tiiny.'
        : 'Its services aren’t answering yet. This usually takes a minute or two after a restart or after logging in. This page checks again by itself.'))));
  } else if (st === 'login') {
    el.append(h('div', {class: 'banner warn'}, icon('key'), h('div', {class: 'text'}, h('strong', {}, 'Log in to your device'),
      h('span', {class: 'small'}, o?.conn?.key_set ? 'The saved API key was rejected.' : 'No API key yet. Log in once and the CLI remembers it.')),
      btn('Log in', loginDialog, {kind: 'primary', icon: 'login'}), btn('Activate a new device', activateTerminal, {kind: 'ghost'})));
  }
  const npu = o?.npu?.json?.npu;
  if (st === 'online' && npu && npu.status && npu.status !== 'ready') {
    el.append(h('div', {class: 'banner warn'}, icon('alert'), h('div', {class: 'text'}, h('strong', {}, `NPU status: ${npu.status}`), h('span', {class: 'small'}, npu.status_message || npu.reason || ''))));
  }
}

function renderDevice(el, o) {
  clear(el);
  if (!o) { el.append(h('p', {class: 'muted'}, 'No data.')); return; }
  const d = o.device?.json || {};
  const acct = o.account?.json || {};
  const usb = d.usb || {};
  const transport = (d.transport || []).join(', ').toUpperCase();
  const npu = o.npu?.json?.npu || {};
  el.append(h('div', {class: 'stack'},
    h('div', {class: 'row'}, h('div', {class: 'model-icon', style: {color: 'var(--accent)'}}, icon('cpu')),
      h('div', {class: 'model-title'}, h('strong', {}, d.device_name || acct.user_info?.device_name || 'Tiiny'), h('span', {class: 'mono'}, o.conn.address)),
      badge(...({online: ['Online', 'ok'], locked: ['Locked', 'warn'], starting: ['Starting', 'warn'], login: ['Log in', 'warn']}[S.state] || ['Offline', 'err']))),
    kvList([
      ['Address', h('span', {}, h('code', {}, o.conn.address), h('span', {class: 'faint small'}, `  from ${o.conn.sources.address || 'settings'}`))],
      ['Connection', transport ? `${transport}${usb.active ? ' · USB-C link active' : ''}` : null],
      ['NPU', npu.status_message || npu.status],
      ['Account', acct.user_info?.user_name],
      ['Serial number', d.serial_number],
      ['Hostname', d.hostname],
      ['USB-C address', usb.device_ip ? `${usb.device_ip}${usb.active ? '' : ' (not plugged in)'}` : null],
    ])));
}

function renderResources(el, o) {
  clear(el);
  const sys = o?.sys?.json;
  if (!sys) { el.append(stateNote() || h('p', {class: 'muted'}, o?.sys?.error || 'No data.')); return; }
  /* The NPU is the card the models run on, from /api/v1/npu/status. It only reports while a model is loaded; with
     nothing loaded it's idle. sys/status's "NPU-0" is the TiinyOS widget's feed and not that card (its numbers don't
     match the card's, and its total memory changes from reading to reading), so it isn't shown. */
  const card0 = o.npu?.json?.devices?.[0];
  const loaded = o.running?.ok ? (o.running.json?.data || []).length : null;
  const cpuPct = num(o.npu?.json?.cpu?.total_percent) ?? num(sys.cpu?.total_percent);   // npu/status is live; the widget feed can stand still
  const perCore = sys.cpu?.per_core_percent || [];
  const cpu = cpuPct ?? (perCore.length ? perCore.reduce((a, b) => a + b, 0) / perCore.length : null);
  const gb = mb => (mb / 1024).toFixed(1);
  const g = [];
  if (card0 && num(card0.mem_total_mb)) {
    g.push(gauge({label: 'NPU compute', pct: num(card0.util_percent) ?? 0, sub: card0.model || 'NPU'}));
    g.push(gauge({label: 'NPU memory', pct: num(card0.mem_used_mb) / card0.mem_total_mb * 100, sub: `${gb(num(card0.mem_used_mb) || 0)} / ${gb(card0.mem_total_mb)} GB`}));
  } else if (loaded === 0) {
    g.push(gauge({label: 'NPU compute', pct: 0, sub: 'Idle: no model loaded'}));
    g.push(gauge({label: 'NPU memory', pct: 0, sub: `0.0 / ${gb(npuTotalMb())} GB`}));
  } else if (loaded) {
    const pct = [...S.running].reduce((a, id) => a + (num(S.modelsById.get(id)?.npu_usage) || 0), 0);
    g.push(gauge({label: 'NPU compute', pct: null, sub: 'The NPU isn’t reporting right now'}));
    g.push(gauge({label: 'NPU memory', pct: Math.min(100, pct), value: `~${Math.round(Math.min(100, pct))}%`, sub: 'estimated from the loaded models'}));
  }
  const ramPct = num(o.npu?.json?.memory?.usage_percent) ?? (sys.memory?.total_bytes ? sys.memory.used_bytes / sys.memory.total_bytes * 100 : null);
  if (cpu !== null) g.push(gauge({label: 'CPU', pct: cpu, sub: perCore.length ? `${perCore.length} cores` : ''}));
  if (ramPct !== null) g.push(gauge({label: 'RAM', pct: ramPct, sub: sys.memory?.total_bytes ? `${fmtBytes(ramPct / 100 * sys.memory.total_bytes)} / ${fmtBytes(sys.memory.total_bytes)}` : ''}));
  if (sys.disk?.total_bytes) g.push(gauge({label: 'Disk', pct: sys.disk.used_bytes / sys.disk.total_bytes * 100, sub: `${fmtBytes(sys.disk.used_bytes)} / ${fmtBytes(sys.disk.total_bytes)}`}));
  if (sys.gpu && !/synthetic/i.test(sys.gpu.name || '')) g.push(gauge({label: 'GPU', pct: num(sys.gpu.utilization_percent) ?? 0, sub: sys.gpu.name}));
  el.append(h('div', {class: 'gauges'}, g));
}

/* ------------------------------------------------- Right now: what the Tiiny is doing, and for whom */
/* The server pairs the device's task list with this panel's own requests and jobs (tiinyui/activity.py), so a
   task here is "Chat: Trip plans" or "Reviewing my-project" when it's the panel's, and named after the app otherwise. */
const NOW_KINDS = {  // kind of work → [icon, what it is]
  chat: ['chat', 'Chat'], embed: ['search', 'Reading text for search'], rerank: ['list', 'Ranking search results'],
  decide: ['spark', 'Quick decision'], image: ['image', 'Making an image'], transcribe: ['mic', 'Transcribing audio'],
  speech: ['speaker', 'Reading text aloud'], music: ['music', 'Making music'], '3d': ['cube', 'Making a 3D model'],
  video: ['film', 'Making a video'], load: ['box', 'Loading a model'], download: ['download', 'Downloading a model'],
};
const NOW_JOB_ICONS = {'chat-turn': 'chat', review: 'shield', 'meeting-summary': 'users', 'meeting-highlights': 'users', 'project-index': 'folder',
  'project-memory': 'folder', music: 'music', model3d: 'cube', video: 'film', 'gallery-tags': 'grid', firmware: 'download'};
const fmtElapsed = s => { s = Math.max(0, Math.round(Number(s) || 0));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}` : `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`; };
const pageTitle = href => { const id = String(href || '').split(/[/?]/)[0]; return VIEWS.find(v => v.id === id)?.title || null; };

/* [icon, title] of a task */
function nowWhat(t) {
  if (t.kind === 'job') return [NOW_JOB_ICONS[t.jobkind] || 'activity', t.title || 'Background job'];
  const [ic, what] = NOW_KINDS[t.kind] || ['activity', t.modality ? humanize(t.modality) : 'Working'];
  if (t.kind === 'load') return [ic, `Loading ${shortName(t.model)}`];
  if (t.kind === 'download') return [ic, `Downloading ${t.title}`];
  if (t.jobkind) return [NOW_JOB_ICONS[t.jobkind] || ic, t.title || what];  // a cancelled job's last request
  if (t.title) return [ic, t.kind === 'chat' ? `Chat: ${t.title}` : t.title];
  return [ic, what];
}
const nowWho = t => t.mine ? (t.phone ? 'this panel, on a phone' : 'this panel') : (t.app || 'another app or computer');
const cap = text => text ? text[0].toUpperCase() + text.slice(1) : text;
function nowHref(t) {
  if (!t.jobkind) return t.href || null;
  const m = t.meta || {};
  if (t.jobkind === 'chat-turn' && m.chat) return `chat/${m.chat}`;
  if (t.jobkind === 'review' && m.review) return `review/${m.review}`;
  if (/^meeting/.test(t.jobkind) && m.meeting) return `meetings/${m.meeting}`;
  if (/^project/.test(t.jobkind) && m.project) return `projects/${m.project}`;
  return {music: 'studio', model3d: 'studio', video: 'studio', 'gallery-tags': 'gallery', firmware: 'system'}[t.jobkind] || null;
}
/* One line per task, for the agent's device check */
function describeNow(n) {
  if (!n) return 'unknown';
  if (!n.tasks?.length) return 'nothing, the device is idle';
  return n.tasks.map(t => `${nowWhat(t)[1]}${t.model && t.kind !== 'load' ? ` on ${t.model}` : ''} (from ${nowWho(t)}` +
    `${num(t.elapsed) !== null ? `, running for ${fmtElapsed(t.elapsed)}` : ''}${num(t.progress) !== null ? `, ${Math.round(t.progress * 100)}% done` : ''})`).join('; ');
}

async function stopNow(t, all) {
  const same = all.filter(x => x.model === t.model && !['job', 'load', 'download'].includes(x.kind));
  const ok = await confirmDialog({title: `Stop the work on ${shortName(t.model)}?`, danger: true, confirmLabel: 'Stop',
    message: h('div', {class: 'stack-sm'},
      h('p', {}, same.length > 1 ? 'Everything running on this model stops:' : 'This stops:'),
      h('ul', {class: 'now-stop-list'}, same.map(x => h('li', {}, `${nowWhat(x)[1]}, from ${nowWho(x)}`))),
      h('p', {class: 'muted'}, 'The model stays loaded.'))});
  if (ok) await interruptModel(t.model);
}
async function cancelNowJob(t) {
  const ok = await confirmDialog({title: `Cancel “${t.title}”?`, message: 'It stops at its next step. You can start it again later.',
    confirmLabel: 'Cancel it', danger: true});
  if (!ok) return;
  await api(`/api/jobs/${encodeURIComponent(t.job)}/cancel`, {method: 'POST'});
  toast('Cancelling…', 'ok');
}

function nowRow(t, all) {
  const [ic, title] = nowWhat(t);
  const href = nowHref(t);
  const model = !['load', 'download'].includes(t.kind) && t.model ? shortName(t.model) : null;
  const page = t.mine && !t.jobkind && !(t.kind === 'chat' && t.title) ? pageTitle(href) : null;
  const who = ['load', 'download'].includes(t.kind) ? null : t.kind === 'job' ? null : cap(nowWho(t)) + (page ? ` · ${page}` : '');
  const sub = [model, who, t.stopping ? 'Cancelled; the device is finishing its last step' : null, t.message || null,
    t.waiting ? `${t.waiting} more waiting` : null].filter(Boolean).join(' · ');
  const pct = num(t.progress);
  const actions = [];
  if (href && !location.hash.startsWith(`#/${href}`)) actions.push(linkBtn('Open', `#/${href}`));
  if (t.kind === 'job' && t.jobkind !== 'firmware') actions.push(btn('Cancel', () => cancelNowJob(t), {small: true, kind: 'ghost', icon: 'x'}));
  else if (t.model && !['job', 'load', 'download'].includes(t.kind)) actions.push(btn('Stop', () => stopNow(t, all), {small: true, kind: 'ghost', icon: 'stop'}));
  return h('div', {class: 'now-row', dataset: {key: t.key || ''}},
    h('div', {class: 'now-ic', 'aria-hidden': 'true'}, icon(ic)),
    h('div', {class: 'now-main'},
      h('div', {class: 'now-title', title}, title),
      sub && h('div', {class: 'now-sub', title: sub}, sub),
      pct !== null && progressBar(pct * 100, {indeterminate: pct <= 0})),  // nothing done yet: moving, not a stuck 0%
    h('div', {class: 'now-side'},  // always the same three cells, so the list lines up in columns
      h('span', {class: 'now-pct'}, pct > 0 ? `${Math.round(pct * 100)}%` : null),
      num(t.elapsed) !== null ? h('span', {class: 'now-time', title: 'Running for', dataset: {since: String(Date.now() - t.elapsed * 1000)}}, fmtElapsed(t.elapsed))
        : h('span', {class: 'now-time-none'}),
      h('div', {class: 'now-actions'}, actions)));
}

function nowLast(l) {
  const ago = fmtAgo(new Date(Date.now() - (num(l.ago) || 0) * 1000));
  if (!l.ended) return `Last used ${ago}${l.model ? `: ${shortName(l.model)}` : ''}.`;
  return `Last: ${nowWhat(l)[1]}${l.model && l.kind !== 'job' ? ` on ${shortName(l.model)}` : ''}, from ${nowWho(l)}, finished ${ago}.`;
}

function nowCard(ctx) {
  const body = h('div', {class: 'now-body'}, loadingBlock());
  const el = card({title: 'Right now', sub: 'What your Tiiny is doing', cls: 'now-card', actions: [btn('Live monitor', () => (S.state === 'locked'
    ? loginDialog({reason: 'Your Tiiny is locked, so the monitor can’t start yet. Log in to unlock it, then open the monitor again.'})
    : openTerminal({args: ['top'], title: 'Live NPU monitor (tiiny top)'})), {small: true, icon: 'terminal', kind: 'ghost'})]}, body);
  el.id = 'now-card';
  const subEl = el.querySelector('.card-head .titles p');
  ctx.every(1000, () => {  // the clocks tick between updates
    for (const s of body.querySelectorAll('.now-time')) s.textContent = fmtElapsed((Date.now() - Number(s.dataset.since)) / 1000);
  });
  function render(o) {
    clear(body);
    const note = S.state !== 'online' ? stateNote() : null;
    if (note || !o?.now || !o?.npu?.ok) {
      el.classList.remove('busy');
      body.append(note || h('p', {class: 'muted'}, o?.npu?.error || 'Can’t tell right now.'));
      return;
    }
    const downloads = (Downloads.list || []).map(m => ({key: `dl:${m.id}`, kind: 'download', title: m.display_name || m.name || shortName(m.id),
      progress: num(m.progress) !== null ? num(m.progress) / 100 : null}));
    const tasks = [...(o.now.tasks || []), ...downloads];
    el.classList.toggle('busy', tasks.length > 0);
    subEl.textContent = tasks.length ? `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} running` : 'What your Tiiny is doing';
    if (!tasks.length) {
      body.append(h('div', {class: 'now-idle'}, h('span', {class: 'now-dot', 'aria-hidden': 'true'}),
        h('div', {}, h('strong', {}, 'Idle'), h('span', {class: 'muted'}, ' · Nothing is running on your Tiiny.'),
          o.now.last && h('div', {class: 'now-last'}, nowLast(o.now.last)))));
      return;
    }
    body.append(h('div', {class: 'now-list'}, tasks.map(t => nowRow(t, tasks))));
  }
  return {el, render};
}

function renderLoadedModels(el) {
  clear(el);
  const ids = [...S.running];
  const loading = [...S.loading.keys()].filter(id => !S.running.has(id));
  if (!ids.length && !loading.length) {
    const note = stateNote();
    if (note) { el.append(note); return; }
    el.append(emptyState('box', 'No models loaded', 'Load a model to chat with it or use it in the Playground.', linkBtn('Choose a model', '#/models', {kind: 'primary'})));
    return;
  }
  el.append(h('div', {class: 'model-grid'}, [...ids, ...loading].map(id => modelCard(S.modelsById.get(id) || {id, name: id, type: ''}, {compact: true}))));
}

/* ------------------------------------------------------------------- Models */
function modelCard(m, {compact = false, store = false, onChange} = {}) {
  const id = store ? (m.fullname || m.model_id || m.id) : m.id;
  const running = S.running.has(id);
  const loading = S.loading.get(id);
  const dl = Downloads.list.find(x => x.id === id);
  const status = String(m.status || '').toLowerCase();
  const think = m.thinking || {};
  const el = h('div', {class: `model-card ${running ? 'running' : ''}`});
  const actions = h('div', {class: 'model-actions'});
  append(el, [
    h('div', {class: 'model-head'}, modelIcon(m),
      h('div', {class: 'model-title'}, h('strong', {title: m.display_name || m.name}, m.display_name || m.name || id), h('span', {class: 'mono', title: id}, id)),
      running ? badge('Loaded', 'ok', 'check') : loading ? badge('Loading', 'accent') : null),
    h('div', {class: 'model-meta'}, m.type && typeBadge(m), m.params && badge(m.params), isVision(m) && badge('Vision', '', 'eye'),
      think.supported && badge(think.toggleable ? 'Thinking' : 'Always thinks', '', 'brain'), m.need_update && badge('Update', 'warn'),
      store && m.is_trend && badge('Trending', 'accent', 'star')),
    !compact && m.desc && h('div', {class: 'model-desc'}, String(m.desc).replace(/[#*_`>]/g, '').slice(0, 400)),
    h('div', {class: 'model-stats'},
      m.total_size ? h('span', {}, 'Size ', h('b', {}, fmtBytes(m.total_size, {si: true}))) : null,
      num(m.npu_usage) ? h('span', {}, 'NPU ', h('b', {}, `${m.npu_usage}%`)) : null,
      m.load_time ? h('span', {}, 'Loads in ', h('b', {}, fmtSecs(m.load_time))) : null,
      store && num(m.downloads) !== null ? h('span', {class: 'model-downloads', title: `${Number(m.downloads).toLocaleString('en')} downloads`},
        icon('download'), ' ', h('b', {}, fmtCount(m.downloads))) : null,
      store && m.likes ? h('span', {title: `${m.likes} likes`}, icon('heart'), ' ', h('b', {}, String(m.likes))) : null),
    loading ? h('div', {class: 'stack-sm'}, h('div', {class: 'model-progress'}, loading.pct !== null ? `Loading… ${Math.round(loading.pct)}%` : `Loading into NPU memory${loading.expected ? ` (about ${fmtSecs(loading.expected)})` : '…'}`),
      progressBar(loading.pct ?? 0, {indeterminate: loading.pct === null})) : null,
    dl ? h('div', {class: 'stack-sm'}, h('div', {class: 'model-progress'}, `Downloading… ${Math.round(num(dl.progress) || 0)}%`), progressBar(num(dl.progress) || 0)) : null,
    !store && running ? borrowedNote(id) : null,
    actions]);
  const refresh = () => { if (onChange) onChange(); };
  if (store) {
    if (dl) actions.append(btn('Cancel', () => cancelDownload(id, m.name), {small: true, icon: 'x', kind: 'ghost'}));
    else if (status === 'downloaded' || S.modelsById.has(id)) append(actions, [badge('On your device', 'ok', 'check'), S.running.has(id) ? null : btn('Load', () => loadModel(id), {small: true, icon: 'play'})]);
    else actions.append(btn('Download', () => downloadModel(id).then(refresh), {small: true, icon: 'download', kind: 'primary'}));
    actions.append(h('span', {class: 'spacer'}), btn('Details', () => modelDetails(id), {small: true, kind: 'ghost', icon: 'info'}));
    return el;
  }
  if (running) {
    if (TYPES.chat(m)) actions.append(btn('Chat', () => { ChatUI.preset = id; go('chat'); }, {small: true, icon: 'chat', kind: 'primary'}));
    if (TYPES.decide(m)) actions.append(btn('Try it', () => tryDecisionModel(id), {small: true, icon: 'spark', kind: 'primary'}));
    actions.append(btn('Unload', () => unloadModel(id), {small: true, icon: 'power'}));
  } else if (!loading) {
    actions.append(btn('Load', () => loadModel(id), {small: true, icon: 'play', kind: 'primary'}));
    if (TYPES.decide(m)) actions.append(btn('Try it', () => tryDecisionModel(id), {small: true, icon: 'spark', kind: 'ghost'}));
  }
  actions.append(h('span', {class: 'spacer'}), menuButton([
    {label: 'Details', icon: 'info', fn: () => modelDetails(id)},
    running && {label: 'Interrupt current task', icon: 'stop', fn: () => interruptModel(id)},
    TYPES.chat(m) && {label: 'Benchmark speed', icon: 'bolt', fn: () => benchModel(id)},
    {label: 'Copy model ID', icon: 'copy', fn: () => copyText(id, 'Model ID copied')},
    !compact && {label: 'Delete from device', icon: 'trash', danger: true, fn: async () => { await deleteModel(id); refresh(); }},
  ]));
  return el;
}

function viewModels(root, ctx) {
  let tab = sessionStorage.getItem('tiiny.modelsTab') || 'library';
  const startQuery = sessionStorage.getItem('tiiny.modelsQuery') || '';  // set by links like Studio's "Get it"
  sessionStorage.removeItem('tiiny.modelsQuery');
  let query = startQuery.toLowerCase();
  let type = 'all';
  const SORTS = [['recommended', 'Recommended'], ['downloads', 'Most downloaded'], ['trending', 'Trending'], ['likes', 'Most liked'], ['name', 'Name']];
  let sort = sessionStorage.getItem('tiiny.storeSort');
  if (!SORTS.some(([k]) => k === sort)) sort = 'recommended';
  const seg = segmented([['library', 'On this device'], ['store', 'Model store']], tab, t => { tab = t; type = 'all'; sessionStorage.setItem('tiiny.modelsTab', t); if (t === 'store' && !S.store) refreshStore(); render(); });
  const sortSel = h('select', {class: 'input sm', style: {width: 'auto'}, 'aria-label': 'Sort store models',
    onchange: e => { sort = e.target.value; sessionStorage.setItem('tiiny.storeSort', sort); render(); }},
    SORTS.map(([v, l]) => h('option', {value: v, selected: v === sort}, l)));
  const chips = h('div', {class: 'row wrap gap-sm chip-row'});
  const dlBox = h('div');
  const body = h('div', {}, loadingBlock('Loading models…'));
  const plannerBox = h('div');
  const memRow = h('div', {class: 'grid cols-2'}, card({title: 'NPU memory', ic: 'cpu'}, plannerBox), typeof idleCard === 'function' ? idleCard(ctx) : h('div'));
  const renderPlanner = () => { if (typeof npuPlanner === 'function' && S.modelsAt) clear(plannerBox).append(npuPlanner()); };
  ctx.on('running', renderPlanner);
  ctx.on('models', renderPlanner);
  root.append(
    h('div', {class: 'toolbar'}, seg, searchBox('Search models…', v => { query = v.toLowerCase(); render(); }, startQuery), sortSel, h('span', {class: 'spacer'}),
      btn('Import from Hugging Face', importModel, {icon: 'download', kind: 'ghost'}),
      iconBtn('refresh', 'Refresh', async () => { await Promise.all([refreshModels(), refreshRunning(), tab === 'store' ? refreshStore() : null, Downloads.poll()]); }, {small: false})),
    memRow, dlBox, chips, body);

  function list() { return tab === 'store' ? (S.store || []) : S.models; }
  function render() {
    sortSel.hidden = tab !== 'store';
    memRow.hidden = tab !== 'library';
    renderPlanner();
    renderDownloads();
    const all = list();
    if (tab === 'store' && S.store === null) { clear(body).append(loadingBlock('Loading the model store…')); clear(chips); return; }
    if (tab === 'library' && !S.modelsAt) {
      clear(body).append(S.modelsError ? errorBlock(S.modelsError, {retry: refreshModels, title: 'Couldn’t list models'}) : loadingBlock('Loading models…'));
      clear(chips);
      return;
    }
    const counts = new Map();
    for (const m of all) counts.set(m.type || 'Other', (counts.get(m.type || 'Other') || 0) + 1);
    append(clear(chips), [
      h('button', {class: `chip ${type === 'all' ? 'active' : ''}`, type: 'button', onclick: () => { type = 'all'; render(); }}, 'All', h('span', {class: 'n'}, String(all.length))),
      [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => h('button', {class: `chip ${type === t ? 'active' : ''}`, type: 'button', onclick: () => { type = t; render(); }}, t, h('span', {class: 'n'}, String(n))))]);
    let rows = all.filter(m => (type === 'all' || (m.type || 'Other') === type) &&
      (!query || [m.name, m.display_name, m.fullname, m.id, m.type, m.desc, (m.tags || []).join(' ')].join(' ').toLowerCase().includes(query)));
    if (tab === 'store') {
      const by = {recommended: m => num(m.recommend_rank) ?? 1e9, downloads: m => -(num(m.downloads) ?? 0), trending: m => -(num(m.trending_score) ?? 0),
        likes: m => -(num(m.likes) ?? 0), name: m => 0};
      rows = rows.slice().sort((a, b) => sort === 'name' ? String(a.name).localeCompare(String(b.name)) : by[sort](a) - by[sort](b));
    } else {
      rows = rows.slice().sort((a, b) => (S.running.has(b.id) - S.running.has(a.id)) || String(a.type).localeCompare(String(b.type)) || String(a.name).localeCompare(String(b.name)));
    }
    clear(body);
    if (!rows.length) {
      body.append(tab === 'library' && !all.length
        ? emptyState('box', 'No models on this device yet', 'Download one from the model store to get started.', btn('Open the model store', () => seg.set('store') || (tab = 'store', sessionStorage.setItem('tiiny.modelsTab', 'store'), refreshStore(), render()), {kind: 'primary', icon: 'download'}))
        : emptyState('search', 'No matches', 'Try a different search or filter.'));
      return;
    }
    const usedPct = [...S.running].reduce((a, id) => a + (num(S.modelsById.get(id)?.npu_usage) || 0), 0);
    if (tab === 'library') {
      body.append(h('p', {class: 'muted small', style: {marginBottom: '10px'}},
        `${S.models.length} model(s) on the device · ${S.running.size} loaded${usedPct ? ` · about ${usedPct}% of NPU memory in use` : ''}. A model must be loaded before you can use it.`));
    }
    body.append(h('div', {class: 'model-grid'}, rows.map(m => modelCard(m, {store: tab === 'store', onChange: render}))));
  }
  function renderDownloads() {
    clear(dlBox);
    if (!Downloads.list.length) return;
    dlBox.append(card({title: 'Downloading', ic: 'download'}, h('div', {class: 'stack'}, Downloads.list.map(m => h('div', {class: 'stack-sm'},
      h('div', {class: 'row'}, h('strong', {class: 'spacer ellipsis'}, m.display_name || m.name || m.id), h('span', {class: 'small muted'}, `${Math.round(num(m.progress) || 0)}%${m.status ? ` · ${m.status}` : ''}`),
        btn('Cancel', () => cancelDownload(m.id, m.name), {small: true, kind: 'ghost', icon: 'x'})),
      progressBar(num(m.progress) || 0))))));
  }
  ctx.on('models', render);
  ctx.on('store', render);
  ctx.on('running', render);
  ctx.on('loading', render);
  ctx.on('downloads', render);
  render();
  refreshModels();
  refreshRunning();
  Downloads.poll();
  if (tab === 'store') refreshStore();
}

/* ------------------------------------------------------- Chat helpers (shared) */
function splitThinking(m) {
  let reasoning = m.reasoning || '';
  let answer = m.content || '';
  const open = answer.indexOf('<think>');
  if (open !== -1) {
    const close = answer.indexOf('</think>', open);
    if (close === -1) { reasoning += answer.slice(open + 7); answer = answer.slice(0, open); }
    else { reasoning += answer.slice(open + 7, close); answer = answer.slice(0, open) + answer.slice(close + 8); }
  } else if (answer.includes('</think>')) {
    const close = answer.indexOf('</think>');
    reasoning += answer.slice(0, close);
    answer = answer.slice(close + 8);
  }
  return {reasoning: reasoning.trim(), answer: answer.replace(/^\s+/, '')};
}

async function shrinkImage(file, maxSide) {
  const dataUrl = await readAs(file, 'dataurl');
  if (!/^data:image\/(png|jpe?g|webp)/.test(dataUrl)) return dataUrl;
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('Unsupported image')); i.src = dataUrl; });
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale >= 1 && file.size < 1.5e6) return dataUrl;
  const canvas = h('canvas', {width: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale)});
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.9);
}

async function profileContext() {
  const r = await dev('/kb/user-context', {service: 'kb', quiet: true, silent: true});
  const p = r.ok ? (r.json?.profile || {}) : {};
  const lines = [];
  if (p.user_name) lines.push(`Name: ${p.user_name}`);
  if (p.occupation) lines.push(`Occupation: ${p.occupation}`);
  if (p.preferences) lines.push(`Preferences: ${p.preferences}`);
  if (p.more_about_you) lines.push(`More about them: ${p.more_about_you}`);
  return lines.length ? `About the user (from their Tiiny profile):\n${lines.join('\n')}` : '';
}

function normalizeHits(j) {
  const arr = Array.isArray(j) ? j : (findArray(j, ['results', 'chunks', 'items', 'hits', 'documents', 'matches', 'contexts']) || []);
  return arr.map(x => {
    if (typeof x === 'string') return {text: x, source: '', score: null, keywords: []};
    const metaObj = x.metadata && typeof x.metadata === 'object' ? x.metadata : {};
    let text = String(pick(x, 'lossless_restatement', 'text', 'content', 'chunk', 'chunk_text', 'document', 'page_content', 'preview', 'snippet') ?? JSON.stringify(x));
    text = text.replace(/^Source file:[^\n]*\n+/, '').replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1').trim();
    const recalls = Array.isArray(x.recalls) ? x.recalls : [];
    const semantic = recalls.find(r => r && r.arm === 'semantic');
    return {
      text,
      source: String(pick(x, 'filename', 'file_name', 'source_name', 'title', 'source', 'name') ?? pick(metaObj, 'filename', 'source', 'title') ?? pick(x, 'source_id') ?? ''),
      score: num(semantic?.score) ?? num(pick(x, 'score', 'similarity', 'relevance', 'relevance_score')),
      keywords: Array.isArray(x.keywords) ? x.keywords.filter(k => typeof k === 'string' && k.length > 2).slice(0, 6) : [],
      raw: x,
    };
  });
}
async function vaultSearch(q, k = 4) {
  const r = await dev('/kb/retrieve', {service: 'kb', method: 'POST', json: {question: q}, quiet: true, silent: true, timeout: 90});
  return r.ok ? normalizeHits(r.json).slice(0, k) : [];
}

/* -------------------------------------------------------------------- Vault */
const VAULT_LIMIT = 200 * 1024 * 1024;
const VaultUploader = {
  queue: [], busy: false, autoIndex: true,
  enqueue(files, {onDone} = {}) {
    for (const f of files) {
      const item = {id: uid(), file: f, name: f.name, size: f.size, stage: 'Waiting…', pct: 0, state: 'wait', onDone};
      if (f.size > VAULT_LIMIT) { item.state = 'failed'; item.stage = 'Files over 200 MB can’t be added to the Vault.'; }
      this.queue.unshift(item);
    }
    emit('vault-queue');
    this.run();
  },
  async run() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const item = this.queue.slice().reverse().find(x => x.state === 'wait');
        if (!item) break;
        await this.process(item);
      }
    } finally { this.busy = false; }
  },
  async process(item) {
    const set = patch => { Object.assign(item, patch); emit('vault-queue'); };
    try {
      set({state: 'run', stage: 'Sending to the panel…'});
      const up = await uploadFile(item.file, p => set({pct: p * 50}));
      set({stage: 'Uploading to your Tiiny…', pct: 55});
      const r = await dev('/kb/upload', {service: 'kb', method: 'POST', form: {files: {file: up.id}}, label: `Add ${item.name} to Vault`, timeout: 1800, silent: true});
      if (!r.ok) throw new Error(r.error);
      const sid = pick(r.json || {}, 'source_id') || pick(r.json?.source || r.json?.data || {}, 'source_id');
      set({pct: 80, stage: 'Added.'});
      if (this.autoIndex) {
        set({stage: 'Indexing (making it searchable)…', pct: 85});
        let sourceId = sid;
        if (!sourceId) {
          const list = await dev('/kb/sources', {service: 'kb', query: {limit: 500}, quiet: true, silent: true});
          const items = list.json?.items || [];
          sourceId = items.filter(x => x.filename === item.name).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]?.source_id;
        }
        if (sourceId) {
          const f = await dev('/kb/finalize', {service: 'kb', method: 'POST', json: {source_id: sourceId}, label: `Index ${item.name}`, timeout: 1800, silent: true});
          const why = f.ok ? finalizeFailed(f.json) : f.error;
          if (why) { set({state: 'done', pct: 100, stage: `Added, but indexing failed: ${why}. Load an embedding model, then press Index.`}); emit('vault-changed'); return; }
        }
      }
      set({state: 'done', pct: 100, sourceId: sid, stage: this.autoIndex ? 'Added and indexed.' : 'Added. Press Index when you want it searchable.'});
      emit('vault-changed');
      if (item.onDone) item.onDone(item);
    } catch (e) {
      set({state: 'failed', stage: e.message || String(e)});
    }
  },
};

function vaultStatus(x) {
  const vs = String(x.vectorize_status || '').toLowerCase();
  if (x.vectorize_error_message || /fail|error/.test(vs)) return ['Indexing failed', 'err', x.vectorize_error_message];
  if (x.finalized) return /pend|queue|run|process|progress|start/.test(vs) ? ['Indexing…', 'accent'] : ['Indexed', 'ok'];
  if (x.auto_finalize_requested) return ['Waiting to index', 'accent', 'It is indexed as soon as an embedding model is available.'];
  return ['Not indexed', 'warn', 'Press Index to make it searchable. This needs an embedding model loaded.'];
}

function viewVault(root, ctx) {
  let filter = 'all';
  let query = '';
  let items = null;
  let loadError = '';
  const fileInput = h('input', {type: 'file', multiple: true, hidden: true});
  const autoChk = h('input', {type: 'checkbox', checked: VaultUploader.autoIndex});
  const embedNote = h('div');
  const queueEl = h('div', {class: 'queue'});
  const zone = h('div', {class: 'dropzone', role: 'button', tabindex: '0', 'aria-label': 'Add files to the Vault'},
    icon('upload'), h('strong', {}, 'Drop files here, or click to choose'),
    h('span', {class: 'muted small'}, 'PDFs, Word and text documents, notes, code… up to 200 MB each. Your Tiiny indexes them so chat can find the right passages.'));
  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', () => { VaultUploader.enqueue([...fileInput.files]); fileInput.value = ''; });
  autoChk.addEventListener('change', () => { VaultUploader.autoIndex = autoChk.checked; });
  S.dropHandler = files => VaultUploader.enqueue(files);

  const seg = segmented([['all', 'All'], ['file', 'Files'], ['summary', 'Daily summaries']], filter, v => { filter = v; renderFiles(); });
  const listBody = h('div', {}, loadingBlock('Loading your Vault…'));
  const searchInput = h('input', {class: 'input', type: 'search', placeholder: 'Ask a question or describe what you’re looking for…', 'aria-label': 'Search the Vault'});
  const topK = h('input', {class: 'input', type: 'number', min: 1, max: 20, value: 5, style: {width: '80px'}, 'aria-label': 'Number of results'});
  const results = h('div', {class: 'stack-sm'});
  const summaryBody = h('div', {}, loadingBlock());
  const webInput = h('input', {class: 'input', type: 'url', placeholder: 'https://example.com/an-article-worth-keeping', 'aria-label': 'Web page address'});
  const webOut = h('div', {class: 'stack-sm'});
  const bookmarklet = `javascript:(()=>{window.open('${location.origin}/#/vault?save='+encodeURIComponent(location.href),'_blank')})()`;

  async function previewPage(url) {
    clear(webOut).append(loadingBlock('Reading the page…'));
    let page;
    try { page = await api('/api/web/fetch', {method: 'POST', body: {url}}); }
    catch (e) { clear(webOut).append(errorBlock(e.message, {title: 'Couldn’t read that page'})); return; }
    const projSel = h('select', {class: 'input sm', style: {width: 'auto'}}, h('option', {value: ''}, 'Also add to a project…'));
    api('/api/projects').then(r => r.projects.forEach(p => projSel.append(h('option', {value: p.id}, p.name)))).catch(() => {});
    clear(webOut).append(h('div', {class: 'hit'},
      h('div', {class: 'hit-head'}, badge(page.kind.toUpperCase(), 'accent'), h('strong', {}, page.title), h('span', {class: 'faint'}, `${page.words.toLocaleString()} words`)),
      h('p', {class: 'muted small'}, page.excerpt), h('a', {href: page.final_url, target: '_blank', rel: 'noopener noreferrer', class: 'small'}, page.final_url)),
      h('div', {class: 'row wrap'}, btn('Save to Vault', async () => {
        const r = await api('/api/web/to-vault', {method: 'POST', body: {page, index: VaultUploader.autoIndex}});
        Activity.add({kind: 'api', label: `Save web page ${page.title}`, ok: true, detail: `${r.filename}${r.indexed === false ? ' (not indexed yet)' : ''}`});
        toast(`Saved “${page.title}” to your Vault`, 'ok', {detail: r.indexed === false ? 'Indexing failed; load an embedding model and press Index.' : ''});
        if (projSel.value) {
          await api(`/api/projects/${projSel.value}/docs`, {method: 'POST', body: {kind: 'url', url: page.final_url}});
          toast('Also added to the project', 'ok');
        }
        webInput.value = '';
        clear(webOut);
        load();
      }, {kind: 'primary', icon: 'download'}), projSel));
  }

  root.append(
    card({title: 'Add files', ic: 'upload', actions: [h('label', {class: 'check small'}, autoChk, h('span', {}, 'Index right after adding'))]},
      h('div', {class: 'stack'}, embedNote, zone, queueEl, fileInput)),
    card({title: 'Add a web page', ic: 'link', sub: 'Keeps the page’s readable text as a Markdown file in your Vault'},
      h('div', {class: 'stack'},
        h('form', {class: 'row', onsubmit: e => { e.preventDefault(); if (webInput.value.trim()) previewPage(webInput.value.trim()); }},
          webInput, btn('Preview', null, {type: 'submit', icon: 'eye'})),
        webOut,
        h('details', {class: 'raw'}, h('summary', {}, 'Save pages straight from your browser'),
          h('div', {class: 'stack-sm', style: {marginTop: '8px'}},
            h('p', {class: 'small'}, 'Drag this button to your bookmarks bar. On any page, click it to open this panel with the page ready to save:'),
            h('div', {}, h('a', {class: 'btn sm', href: bookmarklet, onclick: e => { e.preventDefault(); toast('Drag the button to your bookmarks bar instead of clicking it here', 'info'); }}, icon('link'), 'Save to Tiiny')),
            h('p', {class: 'muted small'}, 'The panel always asks before saving anything.'))))),
    card({title: 'Your files', ic: 'folder', actions: [seg, iconBtn('refresh', 'Refresh', () => load())]},
      h('div', {class: 'stack'}, h('div', {class: 'toolbar'}, searchBox('Filter by name…', v => { query = v.toLowerCase(); renderFiles(); })), listBody)),
    card({title: 'Search your Vault', ic: 'search', sub: 'Semantic search finds passages by meaning, not just exact words'},
      h('form', {class: 'stack', onsubmit: e => { e.preventDefault(); doSearch(); }},
        h('div', {class: 'row wrap search-row'}, searchInput, h('label', {class: 'small muted nowrap row gap-sm'}, 'Results', topK), btn('Search', null, {kind: 'primary', icon: 'search', type: 'submit'})),
        results)),
    card({title: 'Daily conversation summaries', ic: 'clock', sub: 'Each night your Tiiny summarizes the day’s conversations into the Vault'}, summaryBody));

  async function load() {
    const r = await dev('/kb/sources', {service: 'kb', query: {limit: 500}, quiet: true, silent: true, timeout: 30});
    if (!ctx.alive()) return;
    if (r.ok) { items = r.json?.items || findArray(r.json) || []; loadError = ''; }
    else loadError = r.error;
    renderFiles();
    renderEmbedNote();
    if (items && items.some(x => vaultStatus(x)[0] === 'Indexing…')) setTimeout(() => ctx.alive() && load(), 3000);
  }

  function renderEmbedNote() {
    clear(embedNote);
    if (!S.modelsAt) return;
    const embeds = modelsOf('embed');
    if (embeds.some(m => S.running.has(m.id))) return;
    if (!embeds.length) {
      embedNote.append(h('div', {class: 'banner warn'}, icon('alert'), h('div', {class: 'text'}, h('strong', {}, 'No embedding model on your device'),
        h('span', {class: 'small'}, 'Files can be added, but indexing (making them searchable) needs an embedding model such as Qwen3-Embedding-0.6B.')),
        btn('Find one', () => { sessionStorage.setItem('tiiny.modelsTab', 'store'); go('models'); }, {small: true})));
      return;
    }
    const m = embeds[0];
    embedNote.append(h('div', {class: 'banner info'}, icon('info'), h('div', {class: 'text'}, h('strong', {}, 'Indexing needs an embedding model loaded'),
      h('span', {class: 'small'}, `${m.display_name || m.name} is on your device but not loaded.`)),
      btn(`Load ${m.display_name || m.name}`, () => loadModel(m.id), {small: true, icon: 'play', kind: 'primary'})));
  }

  function renderQueue() {
    clear(queueEl);
    const q = VaultUploader.queue.slice(0, 12);
    for (const it of q) {
      queueEl.append(h('div', {class: `qitem ${it.state === 'done' ? 'done' : it.state === 'failed' ? 'failed' : ''}`},
        icon(it.state === 'done' ? 'check' : it.state === 'failed' ? 'alert' : 'file'), h('span', {class: 'name', title: it.name}, it.name),
        h('span', {class: 'small muted'}, fmtBytes(it.size)), h('span', {class: 'stage'}, it.stage),
        it.state === 'run' ? progressBar(it.pct) : null));
    }
    if (VaultUploader.queue.some(x => x.state === 'done' || x.state === 'failed')) {
      queueEl.append(h('div', {}, btn('Clear finished', () => { VaultUploader.queue = VaultUploader.queue.filter(x => x.state === 'wait' || x.state === 'run'); renderQueue(); }, {small: true, kind: 'ghost'})));
    }
  }

  function renderFiles() {
    clear(listBody);
    if (items === null) { listBody.append(loadError ? errorBlock(loadError, {retry: load, title: 'Couldn’t open the Vault'}) : loadingBlock()); return; }
    const isSummary = x => /conversation|summary|day/i.test(x.source_type || '');
    const rows = items.filter(x => (filter === 'all' || (filter === 'summary' ? isSummary(x) : !isSummary(x))) && (!query || String(x.filename || '').toLowerCase().includes(query)));
    if (!items.length) { listBody.append(emptyState('folder', 'Your Vault is empty', 'Drop files above to add them.')); return; }
    if (!rows.length) { listBody.append(emptyState('search', 'Nothing matches', 'Try another filter.')); return; }
    const tbody = h('tbody');
    for (const x of rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))) {
      const [label, kind, why] = vaultStatus(x);
      const chunksRow = h('tr', {hidden: true}, h('td', {colspan: 6}, h('div', {class: 'stack-sm'}, (x.chunks || []).slice(0, 30).map(c => h('div', {class: 'hit'}, h('div', {class: 'hit-head'}, badge(`Passage ${c.chunk_index ?? ''}`)), h('p', {}, c.preview || ''))), !(x.chunks || []).length && h('p', {class: 'muted small'}, 'No passages yet. Index the file first.'))));
      tbody.append(h('tr', {},
        h('td', {}, h('div', {class: 'row gap-sm'}, icon(isSummary(x) ? 'clock' : 'file'), h('div', {style: {minWidth: 0}}, h('div', {class: 'cell-title ellipsis', title: x.filename}, x.filename || x.source_id), h('div', {class: 'cell-sub'}, isSummary(x) ? 'Daily summary' : (x.source_type || 'file'))))),
        h('td', {class: 'nowrap'}, x.size_human || (x.size_bytes != null ? fmtBytes(x.size_bytes) : '—')),
        h('td', {}, h('span', {title: why || ''}, badge(label, kind))),
        h('td', {class: 'nowrap'}, x.chunk_count != null ? String(x.chunk_count) : '—'),
        h('td', {class: 'nowrap', title: fmtDate(x.created_at)}, fmtAgo(x.created_at)),
        h('td', {class: 'actions-col'}, h('div', {class: 'row-actions'},
          label !== 'Indexed' && label !== 'Indexing…' ? btn('Index', () => indexFile(x), {small: true, icon: 'bolt'}) : null,
          iconBtn('eye', 'Show passages', () => { chunksRow.hidden = !chunksRow.hidden; }),
          iconBtn('download', 'Download', () => downloadFile(x)),
          menuButton([
            {label: 'Rename', icon: 'edit', fn: () => renameFile(x)},
            label === 'Indexed' && {label: 'Re-index', icon: 'bolt', fn: () => indexFile(x)},
            {label: 'Copy source ID', icon: 'copy', fn: () => copyText(x.source_id, 'Source ID copied')},
            {label: 'Delete', icon: 'trash', danger: true, fn: () => deleteFile(x)},
          ])))));
      tbody.append(chunksRow);
    }
    listBody.append(h('div', {class: 'table-wrap'}, h('table', {class: 'table'},
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Size'), h('th', {}, 'Status'), h('th', {}, 'Passages'), h('th', {}, 'Added'), h('th', {class: 'actions-col'}, ''))), tbody)),
    h('p', {class: 'muted small', style: {marginTop: '8px'}}, `${rows.length} of ${items.length} item(s)`));
  }

  async function indexFile(x) {
    const r = await dev('/kb/finalize', {service: 'kb', method: 'POST', json: {source_id: x.source_id}, label: `Index ${x.filename}`, timeout: 1800});
    const why = r.ok && finalizeFailed(r.json);
    if (why) toast(`${x.filename} wasn’t indexed`, 'err', {detail: why});
    else if (r.ok) toast(`${x.filename} indexed`, 'ok');
    load();
  }
  async function downloadFile(x) {
    const r = await dev(`/kb/files/${encodeURIComponent(x.source_id)}`, {service: 'kb', save: x.filename || 'download', label: `Download ${x.filename}`, timeout: 600});
    if (r.ok && r.file) triggerDownload(fileHref(r.file, true), r.file.name);
  }
  async function renameFile(x) {
    const v = await formDialog({title: 'Rename file', fields: [{name: 'name', label: 'New name', value: x.filename, required: true, maxlength: 180}]});
    if (!v || v.name === x.filename) return;
    const r = await dev(`/kb/sources/${encodeURIComponent(x.source_id)}`, {service: 'kb', method: 'PATCH', json: {filename: v.name}, label: `Rename ${x.filename}`});
    if (r.ok) toast('Renamed', 'ok');
    load();
  }
  async function deleteFile(x) {
    if (!(await confirmDialog({title: `Delete ${x.filename}?`, danger: true, confirmLabel: 'Delete', message: 'The file and its index are removed from your Tiiny. This can’t be undone.'}))) return;
    const r = await dev('/kb/delete-memory', {service: 'kb', method: 'POST', json: {source_id: x.source_id}, label: `Delete ${x.filename}`});
    if (r.ok) toast(`${x.filename} deleted`, 'ok');
    load();
  }

  async function doSearch() {
    const q = searchInput.value.trim();
    if (!q) { searchInput.focus(); return; }
    clear(results).append(loadingBlock('Searching…'));
    const r = await dev('/kb/retrieve', {service: 'kb', method: 'POST', json: {question: q}, label: 'Search Vault', timeout: 120, silent: true});
    clear(results);
    if (!r.ok) {
      results.append(errorBlock(/embed/i.test(r.error || '') ? `${r.error}\nLoad an embedding model on the Models page, then try again.` : r.error, {title: 'Search failed'}));
      return;
    }
    const hits = normalizeHits(r.json).slice(0, Number(topK.value) || 5);
    if (!hits.length) { results.append(emptyState('search', 'No passages found', 'Make sure your files are indexed.'), rawDetails(r.json)); return; }
    append(results, [hits.map((x, i) => h('div', {class: 'hit'}, h('div', {class: 'hit-head'}, badge(`#${i + 1}`, 'accent'), x.source && h('strong', {}, x.source),
      x.score !== null && h('span', {class: 'faint'}, `relevance ${Math.round(x.score * 100)}%`), x.keywords.map(k => badge(k))),
      h('p', {}, x.text.length > 1200 ? x.text.slice(0, 1200) + '…' : x.text))), rawDetails(r.json)]);
  }

  async function loadSummary() {
    const [sch, mdl] = await Promise.all([
      dev('/kb/memory/schedule', {service: 'kb', quiet: true, silent: true}),
      dev('/kb/memory/model', {service: 'kb', quiet: true, silent: true}),
    ]);
    if (!ctx.alive()) return;
    clear(summaryBody);
    if (!sch.ok && !mdl.ok) { summaryBody.append(h('p', {class: 'muted'}, sch.error || 'Not available.')); return; }
    const s = sch.json || {};
    const m = mdl.json || {};
    const pad = n => String(n ?? 0).padStart(2, '0');
    const hours = Array.from({length: 24}, (_, i) => ({value: String(i), label: `${pad(i)}:00`}));
    const startSel = h('select', {class: 'input'}, hours.map(o => h('option', {value: o.value, selected: Number(o.value) === Number(s.nightly_start_hour)}, o.label)));
    const endSel = h('select', {class: 'input'}, hours.map(o => h('option', {value: o.value, selected: Number(o.value) === Number(s.nightly_end_hour)}, o.label)));
    const textModels = modelsOf('chat');
    const modelSel = h('select', {class: 'input'}, h('option', {value: ''}, 'Automatic (any loaded chat model)'),
      textModels.map(x => h('option', {value: x.id, selected: x.id === m.model_id}, x.display_name || x.name)));
    if (m.model_id && !textModels.some(x => x.id === m.model_id)) modelSel.append(h('option', {value: m.model_id, selected: true}, m.model_id));
    summaryBody.append(h('div', {class: 'stack'},
      h('p', {class: 'muted small'}, `Currently runs between ${pad(s.nightly_start_hour)}:${pad(s.nightly_start_minute)} and ${pad(s.nightly_end_hour)}:${pad(s.nightly_end_minute)}${m.automatic_summary_enabled === false ? ' · automatic summaries are off' : ''}.`),
      h('div', {class: 'form-row'}, h('div', {class: 'field'}, h('label', {}, 'Window starts'), startSel), h('div', {class: 'field'}, h('label', {}, 'Window ends'), endSel),
        h('div', {class: 'field'}, h('label', {}, 'Summary model'), modelSel)),
      h('div', {}, btn('Save', async () => {
        const a = await dev('/kb/memory/schedule', {service: 'kb', method: 'PUT', json: {nightly_start_hour: Number(startSel.value), nightly_end_hour: Number(endSel.value)}, label: 'Set summary schedule'});
        let b = {ok: true};
        if (modelSel.value && modelSel.value !== m.model_id) b = await dev('/kb/memory/model', {service: 'kb', method: 'PUT', json: {model_id: modelSel.value}, label: 'Set summary model'});
        if (a.ok && b.ok) toast('Summary settings saved', 'ok');
        loadSummary();
      }, {kind: 'primary', small: true}))));
  }

  const toSave = ctx.query.get('save');
  if (toSave) {
    history.replaceState(null, '', '#/vault');
    webInput.value = toSave;
    previewPage(toSave);
  }
  ctx.on('vault-queue', renderQueue);
  ctx.on('vault-changed', () => load());
  ctx.on('running', renderEmbedNote);
  ctx.on('models', () => { renderEmbedNote(); });
  renderQueue();
  load();
  loadSummary();
  if (!S.modelsAt) refreshModels();
}

/* --------------------------------------------------------------- Playground */
function modelPicker(kind, onChange) {
  const sel = h('select', {class: 'input', 'aria-label': `${TYPE_LABEL[kind]} model`});
  const status = h('div', {class: 'small'});
  const wrap = h('div', {class: 'field'}, h('label', {}, 'Model'), sel, status);
  let lastValue = localStorage.getItem(`tiiny.pg.${kind}`) || '';
  let drawn = false;
  function render() {
    const before = sel.value;
    const list = modelsOf(kind).sort((a, b) => S.running.has(b.id) - S.running.has(a.id));
    clear(sel);
    if (!list.length) sel.append(h('option', {value: ''}, `No ${TYPE_LABEL[kind]} models on your device`));
    for (const m of list) sel.append(h('option', {value: m.id}, `${S.running.has(m.id) ? '● ' : ''}${m.display_name || m.name}`));
    if (list.some(m => m.id === lastValue)) sel.value = lastValue;
    renderStatus();
    // The list can arrive after the tool was drawn: tell it when that changed which model is chosen.
    if (drawn && onChange && sel.value !== before) onChange(sel.value);
    drawn = true;
  }
  function renderStatus() {
    clear(status);
    const id = sel.value;
    if (!id) {
      if (S.modelsAt) status.append(h('span', {class: 'muted'}, 'Get one from the '), h('a', {href: '#/models', onclick: () => sessionStorage.setItem('tiiny.modelsTab', 'store')}, 'model store'), '.');
      return;
    }
    const loading = S.loading.get(id);
    if (S.running.has(id)) status.append(badge('Loaded', 'ok', 'check'));
    else if (loading) status.append(h('span', {class: 'row gap-sm muted'}, h('span', {class: 'spinner'}), `Loading…${loading.pct !== null ? ` ${Math.round(loading.pct)}%` : ''}`));
    else status.append(h('span', {class: 'row gap-sm'}, h('span', {class: 'muted'}, 'Not loaded. It loads automatically when you run.'), btn('Load now', () => loadModel(id), {small: true, kind: 'ghost', icon: 'play'})));
  }
  sel.addEventListener('change', () => { lastValue = sel.value; localStorage.setItem(`tiiny.pg.${kind}`, sel.value); renderStatus(); if (onChange) onChange(sel.value); });
  render();
  return {el: wrap, get value() { return sel.value; }, render, renderStatus};
}
async function ensureLoaded(id, {borrow = false} = {}) {
  if (!id) { toast('Pick a model first', 'err'); return false; }
  if (!borrow) keepBorrowed(id);
  if (S.running.has(id)) return true;
  toast(`Loading ${shortName(id)} first…`, 'info', {timeout: 3000});
  return loadModel(id, {quiet: true, borrow});
}

function viewPlayground(root, ctx) {
  const tools = [
    ['image', 'Image', 'image', toolImage], ['tts', 'Speech', 'speaker', toolTTS], ['asr', 'Transcribe', 'mic', toolASR],
    ['ocr', 'OCR', 'scan', toolOCR], ['embed', 'Embeddings', 'hash', toolEmbed], ['rerank', 'Rerank', 'list', toolRerank],
    ['decide', 'Decide', 'spark', toolDecide],
  ];
  let tab = sessionStorage.getItem('tiiny.pgTab') || 'image';
  const body = h('div');
  const seg = segmented(tools.map(([id, label]) => [id, label]), tab, t => { tab = t; sessionStorage.setItem('tiiny.pgTab', t); render(); });
  root.append(h('div', {class: 'toolbar'}, seg), body);
  const pickers = [];
  function render() {
    clear(body);
    pickers.length = 0;
    S.dropHandler = null;
    const tool = tools.find(t => t[0] === tab) || tools[0];
    tool[3](body, {picker: (kind, cb) => { const p = modelPicker(kind, cb); pickers.push(p); return p; }, ctx});
  }
  const rerender = () => pickers.forEach(p => p.render());
  ctx.on('models', rerender);
  ctx.on('running', rerender);
  ctx.on('loading', () => pickers.forEach(p => p.renderStatus()));
  render();
  if (!S.modelsAt) refreshModels();
  refreshRunning();
}

/* Fit an image into exactly w×h (cover: scale, then crop the overflow evenly). */
async function fitImage(src, w, hgt) {
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('Unsupported image')); i.src = src; });
  const scale = Math.max(w / img.naturalWidth, hgt / img.naturalHeight);
  const sw = w / scale, sh = hgt / scale;
  const c = h('canvas', {width: w, height: hgt});
  c.getContext('2d').drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, w, hgt);
  return c.toDataURL('image/jpeg', 0.92);
}
function imageDims(src) {
  return new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve([i.naturalWidth, i.naturalHeight]); i.onerror = () => reject(new Error('Unsupported image')); i.src = src; });
}
const EDIT_FAMILIES = /flux|hidream|sensenova|qwen_image|qwen-image/i;
/* Image add-ons made for one job only. They're never picked for general edits ("make it night time"). */
const SINGLE_PURPOSE_IMAGE = {'background-remove': 'removing the background', 'object-remove': 'removing objects', outpaint: 'extending a picture past its edges'};
const singlePurpose = id => Object.entries(SINGLE_PURPOSE_IMAGE).find(([k]) => String(id || '').toLowerCase().includes(k))?.[1] || null;

function toolImage(el, {picker, ctx}) {
  const PRESETS = ['512x512', '768x432', '432x768', '768x480', '480x768', '640x480', '480x640', '1024x1024', '1280x960', '960x1280', '1536x864', '864x1536', '1536x960', '960x1536'];
  const handoff = typeof Handoff !== 'undefined' ? Handoff.image : null;
  if (handoff) Handoff.image = null;
  let mode = handoff?.mode === 'edit' ? 'edit' : (sessionStorage.getItem('tiiny.pgImageMode') || 'create');
  let refs = (handoff?.refs || []).map(src => ({src}));
  let parentId = handoff?.parent || null;
  let maxRefs = 10;
  let family = '';
  let sizes = PRESETS;
  const mp = picker('image', id => loadInfo(id));
  const prompt = h('textarea', {class: 'input', rows: 3});
  const negative = h('input', {class: 'input', placeholder: 'low quality, blurry (optional)'});
  const sizeSel = h('select', {class: 'input'});
  const steps = h('input', {class: 'input', type: 'number', min: 1, max: 100, value: 9});
  const seed = h('input', {class: 'input', type: 'number', placeholder: 'random'});
  const result = h('div', {class: 'stack'});
  const gallery = h('div', {class: 'gallery'});
  const refsEl = h('div', {class: 'refs'});
  const refNote = h('div', {class: 'small'});
  const refInput = h('input', {type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true});
  const editBox = h('div', {class: 'field'}, h('label', {}, 'Reference images'), refsEl,
    h('div', {class: 'row wrap gap-sm'}, btn('Add images', () => refInput.click(), {small: true, icon: 'upload'}),
      typeof galleryPicker === 'function' ? btn('From the gallery', async () => { const it = await galleryPicker(); if (it) addRef(await urlToDataUrl(gUrl(it)), it.id); }, {small: true, kind: 'ghost', icon: 'grid'}) : null),
    refNote, refInput);
  const modeSeg = segmented([['create', 'Create'], ['edit', 'Edit an image']], mode, v => { mode = v; sessionStorage.setItem('tiiny.pgImageMode', v); renderMode(); });
  const fillSizes = list => {
    const cur = sizeSel.value;
    append(clear(sizeSel), list.map(s => h('option', {value: s}, s.replace('x', ' × '))));
    if (list.includes(cur)) sizeSel.value = cur;
  };
  fillSizes(PRESETS);
  function renderMode() {
    editBox.hidden = mode !== 'edit';
    if (mode === 'edit' && Number(steps.value) > 25) steps.value = 20;  // the device gives an edit about 2½ minutes
    prompt.placeholder = mode === 'edit' ? 'What to change, e.g. “make it green and put it on a wooden table”' : 'A small cabin beside a quiet lake at sunrise, soft light, film photo';
    run.querySelector('span:last-child').textContent = mode === 'edit' ? 'Apply the edit' : 'Generate';
    renderRefs();
  }
  function renderRefs() {
    clear(refsEl);
    refs.forEach((r, i) => refsEl.append(h('figure', {class: 'ref'}, h('img', {src: r.src, alt: `reference ${i + 1}`}),
      h('button', {type: 'button', class: 'ref-x', title: 'Remove', onclick: () => { refs.splice(i, 1); renderRefs(); }}, icon('x')))));
    if (!refs.length) refsEl.append(h('div', {class: 'muted small'}, 'Add up to ' + maxRefs + ' images (or paste or drop them here). The first one sets the composition.'));
    clear(refNote);
    if (family && !EDIT_FAMILIES.test(family)) refNote.append(h('span', {class: 'warn-text'}, `${shortName(mp.value)} can’t edit images; choose Qwen-Image, FLUX, HiDream or SenseNova.`));
    else if (singlePurpose(mp.value)) refNote.append(h('span', {class: 'warn-text'}, `${shortName(mp.value)} is made for one job: ${singlePurpose(mp.value)}. For other changes, choose another image model.`));
    else if (refs.length > 1 && /flux/i.test(family)) refNote.append(h('span', {class: 'warn-text'}, 'FLUX uses only one reference image.'));
  }
  async function addRef(src, gid) {
    if (refs.length >= maxRefs) { toast(`At most ${maxRefs} reference images`, 'info'); return; }
    refs.push({src});
    if (gid && !parentId) parentId = gid;
    if (refs.length === 1) {  // pick the supported size closest to the image's shape
      try {
        const [w, hgt] = await imageDims(src);
        const ar = w / hgt;
        const best = sizes.map(sz => sz.split('x').map(Number)).sort((a, b) => Math.abs(Math.log(a[0] / a[1] / ar)) - Math.abs(Math.log(b[0] / b[1] / ar))
          || Math.abs(a[0] * a[1] - Math.min(w * hgt, 1048576)) - Math.abs(b[0] * b[1] - Math.min(w * hgt, 1048576)))[0];
        if (best) sizeSel.value = `${best[0]}x${best[1]}`;
      } catch { /* keep the size */ }
    }
    if (mode !== 'edit') { mode = 'edit'; modeSeg.set('edit'); renderMode(); } else renderRefs();
  }
  const addFiles = async files => { for (const f of files.filter(x => x.type.startsWith('image/'))) addRef(await shrinkImage(f, 2048)); };
  refInput.addEventListener('change', () => { addFiles([...refInput.files]); refInput.value = ''; });
  S.dropHandler = files => addFiles(files);
  const onPaste = e => { if (!el.isConnected) return; const fs = [...(e.clipboardData?.files || [])].filter(x => x.type.startsWith('image/')); if (fs.length) { e.preventDefault(); addFiles(fs); } };
  document.addEventListener('paste', onPaste);
  ctx.onCleanup(() => document.removeEventListener('paste', onPaste));
  async function loadInfo(id) {
    family = '';
    if (!id || !S.running.has(id)) { renderRefs(); return; }  // the device only answers these for a loaded model
    const r = await dev('/v1/image/resolutions', {query: {model: id}, quiet: true, silent: true});
    const arr = r.ok ? (Array.isArray(r.json) ? r.json : findArray(r.json, ['resolutions', 'sizes']) || []) : [];
    const list = arr.map(x => typeof x === 'string' ? x.replace(/[:*×]/, 'x') : (x && x.width && x.height ? `${x.width}x${x.height}` : null)).filter(Boolean);
    if (list.length) { sizes = list; fillSizes(list); }
    const st = await dev('/v1/image/status', {query: {model: id}, quiet: true, silent: true});
    const defSteps = num(pick(st.json?.defaults || st.json || {}, 'steps', 'num_inference_steps'));
    if (defSteps) steps.value = defSteps;
    maxRefs = num(st.json?.max_input_images) || 10;
    family = (st.json?.models || []).map(m => `${m.id} ${m.name || ''}`).join(' ') || id;
    renderRefs();
  }
  loadInfo(mp.value);
  ctx.on('running', () => { if (el.isConnected) loadInfo(mp.value); });
  const run = btn('Generate', async () => {
    const model = mp.value;
    const text = prompt.value.trim();
    if (!text) { prompt.focus(); return; }
    const editing = mode === 'edit' && refs.length > 0;
    if (mode === 'edit' && !refs.length) { toast('Add the image to edit first', 'info'); return; }
    if (!(await ensureLoaded(model))) return;
    const [w, hgt] = sizeSel.value.split('x').map(Number);
    const t0 = performance.now();
    clear(result).append(loadingBlock(editing ? `Editing at ${w} × ${hgt}…` : `Generating ${w} × ${hgt}…`));
    const body = {model, prompt: text, width: w, height: hgt, steps: Number(steps.value) || undefined};
    if (negative.value.trim()) body.negative_prompt = negative.value.trim();
    if (seed.value !== '') body.seed = Number(seed.value);
    if (editing) {
      const fitted = await Promise.all(refs.map(r => fitImage(r.src, w, hgt)));
      if (fitted.length === 1 || /flux/i.test(family)) body.image = fitted[0]; else body.images = fitted;
    }
    let r = await dev('/v1/image/generate', {method: 'POST', json: body, save: 'image.png', label: editing ? 'Edit image' : 'Generate image', timeout: 900, silent: true});
    let src = r.ok && r.file ? fileHref(r.file) : null;
    let fileId = r.ok && r.file ? r.file.id : null;
    if (!r.ok && r.status === 404 && !/model/i.test(r.error || '') && !editing) {
      const r2 = await dev('/v1/images/generations', {method: 'POST', json: {model, prompt: text, size: `${w}x${hgt}`, response_format: 'b64_json', n: 1}, label: 'Generate image', timeout: 900, silent: true});
      const b64 = r2.json?.data?.[0]?.b64_json;
      if (r2.ok && b64) {
        src = `data:image/png;base64,${b64}`; r = r2;
        try { fileId = (await uploadFile(await (await fetch(src)).blob(), null, 'image.png')).id; } catch { fileId = null; }
      } else r = r2;
    }
    clear(result);
    if (!src) {
      const dropped = /closed connection|without response|timed out/i.test(r.error || '');
      result.append(errorBlock(dropped && editing ? 'The device stopped the edit before it finished. Edits get about 2½ minutes: use about 20 steps, or a smaller size.' : (r.error || 'No image returned'),
        {title: editing ? 'The edit failed' : 'Generation failed'}));
      return;
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const savedNote = h('span', {class: 'faint small'});
    const editThis = btn('Edit this', async () => {
      refs = [{src: await urlToDataUrl(src)}];
      if (mode !== 'edit') { mode = 'edit'; modeSeg.set('edit'); }
      renderMode(); prompt.value = ''; prompt.focus();
    }, {small: true, kind: 'ghost', icon: 'edit'});
    result.append(h('img', {class: 'result-img', src, alt: text, style: {maxHeight: '560px', margin: '0 auto'}}),
      h('div', {class: 'row wrap'}, h('span', {class: 'muted small spacer'}, `${w} × ${hgt} · ${secs} s`), savedNote,
        typeof urlToDataUrl === 'function' ? editThis : null,
        r.file ? h('a', {class: 'btn sm', href: fileHref(r.file, true), download: 'tiiny-image.png'}, icon('download'), 'Download') : h('a', {class: 'btn sm', href: src, download: 'tiiny-image.png'}, icon('download'), 'Download')));
    gallery.prepend(h('figure', {}, h('img', {src, alt: text, title: text, onclick: () => modal({title: 'Image', size: 'xwide', body: h('img', {src, alt: text, class: 'result-img', style: {margin: '0 auto'}})})}), h('figcaption', {}, text)));
    if (fileId && typeof galleryAdd === 'function') {
      const rec = await galleryAdd({kind: 'image', file_id: fileId, src, prompt: text, negative_prompt: body.negative_prompt, model, source: 'playground', parent_id: editing ? parentId : null,
        params: {width: w, height: hgt, steps: body.steps, seed: body.seed, mode: editing ? 'edit' : 'create', references: editing ? refs.length : 0}});
      if (rec) clear(savedNote).append(icon('check'), ' Saved to the ', h('a', {href: `#/gallery?open=${rec.id}`}, 'gallery'));
    }
  }, {kind: 'primary', icon: 'spark'});
  el.append(h('div', {class: 'grid cols-2'},
    card({title: 'Make an image', ic: 'image', actions: [modeSeg]}, h('div', {class: 'form'}, mp.el, editBox, h('div', {class: 'field'}, h('label', {}, 'Prompt'), prompt),
      h('div', {class: 'field'}, h('label', {}, 'Negative prompt'), negative),
      h('div', {class: 'form-row'}, h('div', {class: 'field'}, h('label', {}, 'Size'), sizeSel), h('div', {class: 'field'}, h('label', {}, 'Steps'), steps), h('div', {class: 'field'}, h('label', {}, 'Seed'), seed)),
      h('div', {}, run))),
    card({title: 'Result', ic: 'image', actions: [linkBtn('Gallery', '#/gallery?kind=image', {ic: 'grid'})]}, h('div', {class: 'stack'}, result, h('div', {class: 'section-title'}, 'This session'), gallery))));
  if (handoff?.prompt) prompt.value = handoff.prompt;
  renderMode();
}

/* Text to speech. Qwen3-TTS models come in three kinds, and the device decides how to speak from what the request
   includes (checked on a device): a written voice description (`instructions`) for VoiceDesign models, a recording
   plus exactly what it says (`ref_audio`, `ref_text`) for Base models, and otherwise a built-in voice (`voice`), which
   only CustomVoice and other single-voice models have. Without the right fields the device answers
   “custom_voice is not supported by this model”. */
const TTS_MODES = [['design', 'Describe a voice'], ['clone', 'Copy a voice'], ['builtin', 'Built-in voice']];
function ttsModeFor(id) {  // by the model's id and its display name (the device calls the Base model “Qwen3-VoiceClone”)
  const m = S.modelsById?.get(id);
  const names = `${id} ${m?.display_name || ''} ${m?.name || ''}`;
  return /voice-?design/i.test(names) ? 'design' : /voice-?clone|tts\S*[-_]base\b/i.test(names) ? 'clone' : 'builtin';
}
const TTS_VOICE_IDEAS = ['A calm, warm female narrator', 'A deep, slow male voice', 'A cheerful young woman, upbeat and quick',
  'An excited sports commentator', 'An old man telling a bedtime story, soft and gentle'];
const TTS_SAMPLE_SECONDS = 20;
function ttsError(msg) {
  if (/custom_voice is not supported/i.test(msg)) return 'This model has no built-in voices. Choose “Describe a voice” or “Copy a voice”.';
  if (/voice_design is not supported/i.test(msg)) return 'This model can’t make a voice from a description. Choose another way above.';
  if (/voice_clone is not supported/i.test(msg)) return 'This model can’t copy a voice. Choose another way above.';
  if (/voice_clone requires/i.test(msg)) return 'Copying a voice needs a voice sample and exactly what it says.';
  return msg;
}

function toolTTS(el, {picker}) {
  let mode = 'builtin';
  const modeSeg = segmented(TTS_MODES, mode, v => { mode = v; renderMode(); });
  const mp = picker('tts', id => { mode = ttsModeFor(id || ''); modeSeg.set(mode); renderMode(); });
  mode = ttsModeFor(mp.value || '');
  modeSeg.set(mode);
  const text = h('textarea', {class: 'input', rows: 5, placeholder: 'Type what you want to hear…'});
  const modeNote = h('small', {class: 'hint'});

  // A built-in voice (CustomVoice and single-voice models)
  const voice = h('input', {class: 'input', placeholder: 'Leave empty for the model’s default voice'});
  const builtinBox = h('div', {class: 'field'}, h('label', {}, 'Voice'), voice, h('small', {class: 'hint'}, 'Some models need a voice name; others have a default.'));

  // Describe a voice (VoiceDesign models)
  const desc = h('textarea', {class: 'input', rows: 2, placeholder: 'e.g. A warm, calm woman in her thirties, speaking slowly and clearly'});
  const designBox = h('div', {class: 'field'}, h('label', {}, 'Describe the voice'), desc,
    h('div', {class: 'row wrap gap-sm'}, TTS_VOICE_IDEAS.map(t => h('button', {type: 'button', class: 'chip', onclick: () => { desc.value = t; }}, t))),
    h('small', {class: 'hint'}, 'Say who is speaking and how: age, tone, speed, mood.'));

  // Copy a voice from a recording (Base models)
  let sample = null;  // {blob: 16 kHz WAV, seconds, name}
  const sampleInfo = h('div', {class: 'small muted'}, 'No sample yet.');
  const samplePlayer = h('div');
  const sampleText = h('textarea', {class: 'input', rows: 2, placeholder: 'Exactly what is said in the sample'});
  const fileInput = h('input', {type: 'file', accept: 'audio/*,video/*', hidden: true,
    onchange: () => { const f = fileInput.files[0]; fileInput.value = ''; if (f) setSample(f, f.name); }});
  async function setSample(blob, name) {
    try {
      const wav = await toWav16k(blob, TTS_SAMPLE_SECONDS);
      sample = {blob: wav.blob, seconds: wav.seconds, name};
      clear(sampleInfo).append(`${name} · ${Math.min(wav.seconds, TTS_SAMPLE_SECONDS).toFixed(1)} s`,
        wav.seconds > TTS_SAMPLE_SECONDS ? ` (only the first ${TTS_SAMPLE_SECONDS} seconds are used)` : '');
      clear(samplePlayer).append(h('audio', {controls: true, src: URL.createObjectURL(wav.blob), style: {width: '100%'}}));
    } catch (e) { toast('That file can’t be used as a voice sample', 'err', {detail: e.message}); }
  }
  let rec = null, recTimer = null;
  const recBtn = btn('Record', async () => {
    if (rec) { rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      const chunks = [];
      rec = new MediaRecorder(stream);
      rec.ondataavailable = e => chunks.push(e.data);
      rec.onstop = () => {
        clearTimeout(recTimer);
        stream.getTracks().forEach(t => t.stop());
        setSample(new Blob(chunks, {type: rec.mimeType || 'audio/webm'}), 'recording');
        rec = null;
        clear(recBtn).append(icon('mic'), h('span', {}, 'Record'));
      };
      rec.start();
      recTimer = setTimeout(() => rec?.stop(), TTS_SAMPLE_SECONDS * 1000);
      clear(recBtn).append(h('span', {class: 'recording'}, h('i'), 'Stop recording'));
    } catch (e) { toast('Microphone unavailable', 'err', {detail: e.message}); rec = null; }
  }, {icon: 'mic'});
  const writeOut = btn('Write it out for me', async () => {
    if (!sample) { toast('Add a voice sample first', 'info'); return; }
    const asr = modelsOf('asr').sort((a, b) => S.running.has(b.id) - S.running.has(a.id))[0];
    if (!asr) { toast('No speech recognition model on your device', 'info', {detail: 'Type what the sample says yourself, or get Whisper from the model store.'}); return; }
    if (!(await ensureLoaded(asr.id))) return;
    writeOut.disabled = true;
    try {
      const up = await uploadFile(sample.blob, null, 'sample.wav');
      const r = await dev('/v1/audio/transcriptions', {method: 'POST', form: {fields: {model: asr.id}, files: {file: up.id}}, label: 'Transcribe voice sample', timeout: 600, silent: true});
      if (!r.ok) throw new Error(r.error || `HTTP ${r.status}`);
      sampleText.value = String((typeof r.json === 'object' && r.json ? pick(r.json, 'text', 'transcript') : r.text) || '').trim();
      sampleText.focus();
    } catch (e) { toast('Couldn’t write it out', 'err', {detail: e.message}); }
    finally { writeOut.disabled = false; }
  }, {small: true, kind: 'ghost', icon: 'edit'});
  const cloneBox = h('div', {class: 'stack-sm'},
    h('div', {class: 'field'}, h('label', {}, 'Voice sample'),
      h('div', {class: 'row wrap'}, btn('Choose a file', () => fileInput.click(), {icon: 'upload'}), recBtn), sampleInfo, samplePlayer, fileInput,
      h('small', {class: 'hint'}, `A clear 5–15 second recording of one person works best (at most ${TTS_SAMPLE_SECONDS} seconds are used). Only copy voices you have permission to use.`)),
    h('div', {class: 'field'}, h('label', {}, 'What the sample says'), sampleText,
      h('div', {class: 'row wrap gap-sm'}, writeOut, h('small', {class: 'hint'}, 'Check it: the words must match the recording.'))));

  function renderMode() {
    builtinBox.hidden = mode !== 'builtin';
    designBox.hidden = mode !== 'design';
    cloneBox.hidden = mode !== 'clone';
    const fits = ttsModeFor(mp.value || '');
    modeNote.textContent = !mp.value ? '' : fits === mode ? 'This way of speaking suits the chosen model.'
      : `The chosen model is made for “${TTS_MODES.find(m => m[0] === fits)[1]}”; this may not work with it.`;
    S.dropHandler = mode === 'clone' ? files => { const f = files.find(x => /^(audio|video)\//.test(x.type)) || files[0]; if (f) setSample(f, f.name); } : null;
  }

  const out = h('div', {class: 'stack'});
  const speak = btn('Speak', async () => {
    const model = mp.value;
    if (!text.value.trim()) { text.focus(); return; }
    const body = {model, input: text.value.trim(), response_format: 'mp3'};
    if (mode === 'design') {
      if (!desc.value.trim()) { toast('Describe the voice first', 'info'); desc.focus(); return; }
      body.instructions = desc.value.trim();
    } else if (mode === 'clone') {
      if (!sample) { toast('Add a voice sample first', 'info'); return; }
      if (!sampleText.value.trim()) { toast('Write what the sample says', 'info'); sampleText.focus(); return; }
    } else if (voice.value.trim()) body.voice = voice.value.trim();
    clear(out).append(loadingBlock('Getting ready…'));  // no old result or error left showing meanwhile
    if (mode === 'clone') {
      body.ref_audio = await readAs(sample.blob, 'dataurl');
      body.ref_text = sampleText.value.trim();
    }
    if (!(await ensureLoaded(model))) { clear(out); return; }
    clear(out).append(loadingBlock('Synthesizing…'));
    const r = await dev('/v1/audio/speech', {method: 'POST', json: body, save: 'speech.mp3', label: 'Text to speech', timeout: 600, silent: true});
    clear(out);
    if (!r.ok || !r.file) { out.append(errorBlock(ttsError(r.error || 'No audio returned'), {title: 'Speech failed'})); return; }
    out.append(h('audio', {controls: true, autoplay: true, src: fileHref(r.file), style: {width: '100%'}}),
      h('div', {}, h('a', {class: 'btn sm', href: fileHref(r.file, true), download: 'tiiny-speech.mp3'}, icon('download'), 'Download MP3')));
  }, {kind: 'primary', icon: 'play'});

  el.append(h('div', {class: 'grid cols-2'},
    card({title: 'Text to speech', ic: 'speaker'}, h('div', {class: 'form'}, mp.el,
      h('div', {class: 'field'}, h('label', {}, 'How it speaks'), modeSeg, modeNote),
      h('div', {class: 'field'}, h('label', {}, 'Text'), text),
      builtinBox, designBox, cloneBox,
      h('div', {}, speak))),
    card({title: 'Audio', ic: 'speaker'}, out)));
  renderMode();
}

async function toWav16k(blob, maxSeconds = 0) {  // maxSeconds: keep only the start
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ac = new Ctx();
  try {
    const buf = await ac.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.ceil((maxSeconds ? Math.min(buf.duration, maxSeconds) : buf.duration) * 16000);
    const off = new OfflineAudioContext(1, Math.max(1, frames), 16000);
    const srcNode = off.createBufferSource();
    srcNode.buffer = buf;
    srcNode.connect(off.destination);
    srcNode.start();
    const data = (await off.startRendering()).getChannelData(0);
    const out = new DataView(new ArrayBuffer(44 + data.length * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + data.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, 16000, true);
    out.setUint32(28, 32000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, data.length * 2, true);
    for (let i = 0; i < data.length; i++) out.setInt16(44 + i * 2, clamp(data[i], -1, 1) * 0x7fff, true);
    return {blob: new Blob([out], {type: 'audio/wav'}), seconds: buf.duration};
  } finally { ac.close(); }
}

function toolASR(el, {picker}) {
  const mp = picker('asr');
  const lang = h('input', {class: 'input', placeholder: 'Auto-detect (or e.g. en, de, zh)'});
  const fileInput = h('input', {type: 'file', accept: 'audio/*,video/*', hidden: true});
  const picked = h('div', {class: 'small muted'}, 'No audio chosen yet.');
  const out = h('div', {class: 'stack'});
  let audio = null;
  let rec = null;
  const recBtn = h('button', {class: 'btn', type: 'button'}, icon('mic'), h('span', {}, 'Record'));
  const setAudio = (blob, name) => {
    audio = {blob, name};
    clear(picked).append(h('div', {class: 'stack-sm'}, h('span', {}, `${name} · ${fmtBytes(blob.size)}`), h('audio', {controls: true, src: URL.createObjectURL(blob), style: {width: '100%'}})));
  };
  fileInput.addEventListener('change', () => { const f = fileInput.files[0]; if (f) setAudio(f, f.name); fileInput.value = ''; });
  recBtn.addEventListener('click', async () => {
    if (rec) { rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      const chunks = [];
      rec = new MediaRecorder(stream);
      rec.ondataavailable = e => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        setAudio(new Blob(chunks, {type: rec.mimeType || 'audio/webm'}), 'recording');
        rec = null;
        clear(recBtn).append(icon('mic'), h('span', {}, 'Record'));
      };
      rec.start();
      clear(recBtn).append(h('span', {class: 'recording'}, h('i'), 'Stop recording'));
    } catch (e) { toast('Microphone unavailable', 'err', {detail: e.message}); rec = null; }
  });
  S.dropHandler = files => { const f = files.find(x => /^(audio|video)\//.test(x.type)) || files[0]; if (f) setAudio(f, f.name); };
  el.append(h('div', {class: 'grid cols-2'},
    card({title: 'Transcribe audio', ic: 'mic'}, h('div', {class: 'form'}, mp.el,
      h('div', {class: 'field'}, h('label', {}, 'Audio'), h('div', {class: 'row wrap'}, btn('Choose a file', () => fileInput.click(), {icon: 'upload'}), recBtn), picked, fileInput,
        h('small', {class: 'hint'}, 'Any common format; it is converted to 16 kHz mono WAV in your browser before upload. You can also drop a file on this page.')),
      h('div', {class: 'field'}, h('label', {}, 'Language'), lang),
      h('div', {}, btn('Transcribe', async () => {
        if (!audio) { toast('Choose or record some audio first', 'info'); return; }
        const model = mp.value;
        if (!(await ensureLoaded(model))) return;
        clear(out).append(loadingBlock('Converting and uploading…'));
        let blob = audio.blob;
        let name = 'audio.wav';
        try { blob = (await toWav16k(audio.blob)).blob; }
        catch { blob = audio.blob; name = audio.name.includes('.') ? audio.name : 'audio.webm'; }
        const up = await uploadFile(blob, null, name);
        clear(out).append(loadingBlock('Transcribing…'));
        const fields = {model};
        if (lang.value.trim()) fields.language = lang.value.trim();
        const r = await dev('/v1/audio/transcriptions', {method: 'POST', form: {fields, files: {file: up.id}}, label: 'Transcribe audio', timeout: 1800, silent: true});
        clear(out);
        if (!r.ok) { out.append(errorBlock(r.error, {title: 'Transcription failed'})); return; }
        const text = typeof r.json === 'object' && r.json ? (pick(r.json, 'text', 'transcript') ?? JSON.stringify(r.json, null, 2)) : (r.text || '');
        append(out, [h('div', {class: 'out-box'}, text), h('div', {class: 'row'}, btn('Copy text', () => copyText(String(text), 'Transcript copied'), {small: true, icon: 'copy'})), r.json ? rawDetails(r.json) : null]);
      }, {kind: 'primary', icon: 'play'})))),
    card({title: 'Transcript', ic: 'file'}, out)));
}

function toolOCR(el, {picker}) {
  const mp = picker('ocr');
  const fileInput = h('input', {type: 'file', accept: 'image/*', hidden: true});
  const preview = h('div', {class: 'small muted'}, 'No image chosen yet. You can also paste or drop one.');
  const out = h('div', {class: 'stack'});
  let dataUrl = '';
  const setImage = async f => {
    try { dataUrl = await shrinkImage(f, 2400); clear(preview).append(h('img', {src: dataUrl, alt: 'image to read', class: 'result-img', style: {maxHeight: '260px'}})); }
    catch (e) { toast('Couldn’t read that image', 'err', {detail: e.message}); }
  };
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) setImage(fileInput.files[0]); fileInput.value = ''; });
  S.dropHandler = files => { const f = files.find(x => x.type.startsWith('image/')); if (f) setImage(f); };
  const onPaste = e => { const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/')); if (f) { e.preventDefault(); setImage(f); } };
  document.addEventListener('paste', onPaste);
  const obs = new MutationObserver(() => { if (!el.isConnected) { document.removeEventListener('paste', onPaste); obs.disconnect(); } });
  obs.observe(document.body, {childList: true, subtree: true});
  el.append(h('div', {class: 'grid cols-2'},
    card({title: 'Read text from an image', ic: 'scan'}, h('div', {class: 'form'}, mp.el,
      h('div', {class: 'field'}, h('label', {}, 'Image'), h('div', {}, btn('Choose an image', () => fileInput.click(), {icon: 'upload'})), preview, fileInput),
      h('div', {}, btn('Extract text', async () => {
        if (!dataUrl) { toast('Choose an image first', 'info'); return; }
        const model = mp.value;
        if (!(await ensureLoaded(model))) return;
        clear(out).append(loadingBlock('Reading…'));
        const r = await dev('/v1/ocr', {method: 'POST', query: {model}, json: {input: dataUrl, response_format: 'json'}, label: 'OCR', timeout: 900, silent: true});
        clear(out);
        if (!r.ok) { out.append(errorBlock(r.error, {title: 'OCR failed'})); return; }
        const j = r.json;
        let text = typeof j === 'object' && j ? pick(j, 'text', 'markdown', 'content', 'result') : r.text;
        if (Array.isArray(text)) text = text.map(x => typeof x === 'string' ? x : pick(x, 'text', 'content') || '').join('\n');
        if (typeof text !== 'string') text = JSON.stringify(j, null, 2);
        append(out, [h('div', {class: 'out-box'}, text), h('div', {}, btn('Copy text', () => copyText(text, 'Text copied'), {small: true, icon: 'copy'})), j ? rawDetails(j) : null]);
      }, {kind: 'primary', icon: 'play'})))),
    card({title: 'Text', ic: 'file'}, out)));
}

function toolEmbed(el, {picker}) {
  const mp = picker('embed');
  const text = h('textarea', {class: 'input', rows: 5, placeholder: 'The quick brown fox jumps over the lazy dog'});
  const dims = h('input', {class: 'input', type: 'number', min: 1, placeholder: 'Model default'});
  const out = h('div', {class: 'stack'});
  el.append(h('div', {class: 'grid cols-2'},
    card({title: 'Create an embedding', ic: 'hash', sub: 'Turns text into a vector for search and clustering'}, h('div', {class: 'form'}, mp.el,
      h('div', {class: 'field'}, h('label', {}, 'Text'), text), h('div', {class: 'field'}, h('label', {}, 'Dimensions'), dims),
      h('div', {}, btn('Embed', async () => {
        if (!text.value.trim()) { text.focus(); return; }
        const model = mp.value;
        if (!(await ensureLoaded(model))) return;
        clear(out).append(loadingBlock('Embedding…'));
        const body = {model, input: text.value.trim()};
        if (dims.value) body.dimensions = Number(dims.value);
        const r = await dev('/v1/embeddings', {method: 'POST', json: body, label: 'Embedding', timeout: 300, silent: true});
        clear(out);
        if (!r.ok) { out.append(errorBlock(r.error, {title: 'Embedding failed'})); return; }
        const vec = r.json?.data?.[0]?.embedding || [];
        const normV = Math.sqrt(vec.reduce((a, b) => a + b * b, 0));
        out.append(kvList([['Dimensions', String(vec.length)], ['Vector length (L2)', normV.toFixed(4)], ['Tokens', r.json?.usage?.total_tokens != null ? String(r.json.usage.total_tokens) : null]]),
          h('div', {class: 'code-block'}, `[${vec.slice(0, 12).map(v => Number(v).toFixed(5)).join(', ')}${vec.length > 12 ? ', …' : ''}]`),
          h('div', {}, btn('Copy full vector (JSON)', () => copyText(JSON.stringify(vec), 'Vector copied'), {small: true, icon: 'copy'})));
      }, {kind: 'primary', icon: 'play'})))),
    card({title: 'Vector', ic: 'hash'}, out)));
}

function toolRerank(el, {picker}) {
  const mp = picker('rerank');
  const query = h('input', {class: 'input', placeholder: 'What is the capital of France?'});
  const docs = h('textarea', {class: 'input', rows: 7, placeholder: 'One candidate per line:\nParis is the capital of France.\nBerlin is in Germany.\nThe Eiffel Tower is in Paris.'});
  const out = h('div', {class: 'stack'});
  el.append(h('div', {class: 'grid cols-2'},
    card({title: 'Rank documents by relevance', ic: 'list'}, h('div', {class: 'form'}, mp.el,
      h('div', {class: 'field'}, h('label', {}, 'Query'), query), h('div', {class: 'field'}, h('label', {}, 'Candidates'), docs),
      h('div', {}, btn('Rerank', async () => {
        const list = docs.value.split('\n').map(s => s.trim()).filter(Boolean);
        if (!query.value.trim() || !list.length) { toast('Enter a query and at least one candidate', 'info'); return; }
        const model = mp.value;
        if (!(await ensureLoaded(model))) return;
        clear(out).append(loadingBlock('Ranking…'));
        const r = await dev('/v1/rerank', {method: 'POST', json: {model, query: query.value.trim(), documents: list}, label: 'Rerank', timeout: 300, silent: true});
        clear(out);
        if (!r.ok) { out.append(errorBlock(r.error, {title: 'Rerank failed'})); return; }
        const res = (findArray(r.json, ['results', 'data']) || []).map(x => ({i: num(pick(x, 'index')), score: num(pick(x, 'relevance_score', 'score', 'relevance')) ?? 0,
          text: typeof x.document === 'string' ? x.document : pick(x.document || {}, 'text') || pick(x, 'text') || list[num(pick(x, 'index'))] || ''})).sort((a, b) => b.score - a.score);
        const max = Math.max(...res.map(x => x.score), 1e-9);
        append(out, [res.map(x => h('div', {class: 'rank'}, h('span', {class: 'score'}, x.score.toFixed(3)), h('div', {}, h('div', {}, x.text), progressBar(x.score / max * 100)))), rawDetails(r.json)]);
      }, {kind: 'primary', icon: 'play'})))),
    card({title: 'Ranking', ic: 'list'}, out)));
}

/* ----------------------------------------------------------------- Decide */
/* Decision models (KnowLine, d3): a state and typed questions in, a probability for every answer out, through the
   device's /v1/systemone (see tiinyui/decide.py). The panel uses one for small decisions in the features below. */
const DECISION_FEATURES = [   // key, what it does, group, short name
  ['agent_tools', 'The agent gets only the tools a message needs', 'chat', 'Agent’s tools'],
  ['chat_thinking', 'Automatic thinking in chat (the “Auto” choice)', 'chat', 'Auto thinking'],
  ['vault_filter', 'Leave out Vault passages that don’t fit the question', 'chat', 'Vault passages'],
  ['command_risk', 'Risk notes on commands the agent wants to run', 'chat', 'Command risk notes'],
  ['review_check', 'Check code-review findings', 'pages', 'Code-review check'],
  ['gallery_tags', 'Tag pictures in the Gallery', 'pages', 'Gallery tags'],
  ['project_memory', 'Skip project memory updates with nothing to remember', 'pages', 'Project memory'],
  ['meeting_highlights', 'Find action items, decisions and questions in meetings', 'pages', 'Meeting action items'],
];
const decisionOn = f => modelsOf('decide').length > 0 && !(S.health?.settings?.decisions_off || []).includes(f);
const decisionLoaded = () => modelsOf('decide').some(m => S.running.has(m.id));
/* Ask for one of the panel's features. Resolves to {model, answers: {id: {best, p, yes, value, confidence}}}, or null
   when the panel should do what it does without one (no decision model, it doesn't fit, switched off, no answer). */
async function decideFor(feature, state, questions, {images, signal, load = true, timeout = 60} = {}) {
  if (!decisionOn(feature)) return null;
  const f = DECISION_FEATURES.find(x => x[0] === feature) || [feature, feature, '', feature];
  const label = `Decision: ${f[1]}`;
  try {
    const r = await api('/api/decide', {method: 'POST', body: {feature, state, questions, images, load, timeout, from: here(), title: `Decision: ${f[3]}`}, signal});
    if (r.unavailable) { Activity.add({kind: 'api', label, ok: true, detail: `Skipped: ${r.unavailable}`}); return null; }
    Activity.add({kind: 'api', label, ok: true, detail: `${shortName(r.model)}: ` + Object.entries(r.answers || {})
      .map(([id, a]) => `${id} ${a.yes != null ? `${Math.round(a.yes * 100)}%` : a.best}`).join(' · ')});
    return r;
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    Activity.add({kind: 'api', label, ok: false, detail: e.message || String(e)});
    return null;
  }
}
function tryDecisionModel(id) {
  try { localStorage.setItem('tiiny.pg.decide', id); } catch { /* storage off */ }
  sessionStorage.setItem('tiiny.pgTab', 'decide');
  if (S.view === 'playground') route(); else go('playground');
}

function toolDecide(el, {picker}) {
  const mp = picker('decide');
  const state = h('textarea', {class: 'input', rows: 5, placeholder: 'What the model decides about: a message, a chat, a review, a document…'});
  let image = null;   // data URL, made small (decision models only need a glance)
  const imgBox = h('div', {class: 'row wrap gap-sm', style: {alignItems: 'center'}});
  const imgInput = h('input', {type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true});
  const qList = h('div', {class: 'stack-sm'});
  const out = h('div', {class: 'stack'}, h('p', {class: 'muted small'}, 'Ask, and each answer shows here with its probability.'));
  const rows = [];
  const KINDS = [['noul', 'Yes / no'], ['choice', 'Pick one'], ['score', 'Score']];
  function addRow(q = {type: 'noul', text: '', options: ''}) {
    if (rows.length >= 64) { toast('At most 64 questions fit in one request', 'info'); return; }
    const type = h('select', {class: 'input sm', 'aria-label': 'Question type'}, KINDS.map(([v, l]) => h('option', {value: v, selected: v === q.type}, l)));
    const text = h('input', {class: 'input sm', placeholder: 'The question, e.g. Is the customer angry?', value: q.text || '', 'aria-label': 'Question'});
    const opts = h('input', {class: 'input sm', value: q.options || '', 'aria-label': 'Options'});
    const row = {type, text, opts};
    const sync = () => { opts.hidden = type.value === 'noul'; opts.placeholder = type.value === 'score' ? 'Levels, lowest first: low, medium, high' : 'Options: billing, shipping, other'; };
    type.addEventListener('change', sync);
    sync();
    row.el = h('div', {class: 'dq-row'}, type, text, opts, iconBtn('x', 'Remove this question', () => { rows.splice(rows.indexOf(row), 1); row.el.remove(); }));
    rows.push(row);
    qList.append(row.el);
  }
  const EXAMPLES = [
    ['Route a support message', 'Customer message: I was charged twice for my order last week and I still haven’t got my money back. This is the third time I’m writing!', [
      {type: 'choice', text: 'Which team should handle this message?', options: 'billing, shipping, technical, other'},
      {type: 'noul', text: 'Is the customer angry or upset?'},
      {type: 'score', text: 'How urgent is this?', options: 'low, medium, high'}]],
    ['Is this spam?', 'Congratulations!!! You have won a $1000 gift card. Click the link below to claim your prize before it expires today.', [
      {type: 'noul', text: 'Is this message spam?'},
      {type: 'choice', text: 'What kind of message is it?', options: 'advert, phishing, personal, work'}]],
    ['Rate a review', 'The battery died after two days and support never answered my emails. Terrible.', [
      {type: 'score', text: 'How many stars would this reviewer give?', options: '1, 2, 3, 4, 5'},
      {type: 'noul', text: 'Does the reviewer mention customer support?'}]],
  ];
  function useExample([, text, qs]) {
    state.value = text;
    rows.splice(0).forEach(r => r.el.remove());
    qs.forEach(q => addRow(q));
  }
  function renderImage() {
    append(clear(imgBox), [image ? h('img', {src: image, alt: 'picture to decide about', class: 'dq-img'}) : null,
      btn(image ? 'Another picture' : 'Add a picture', () => imgInput.click(), {small: true, kind: 'ghost', icon: 'image'}),
      image ? btn('Remove', () => { image = null; renderImage(); }, {small: true, kind: 'ghost', icon: 'x'}) : null]);
  }
  imgInput.addEventListener('change', async () => {
    const f = imgInput.files[0];
    imgInput.value = '';
    if (!f) return;
    try { image = await smallThumb(await readAs(f, 'dataurl'), 768); renderImage(); }
    catch (e) { toast('Couldn’t read that picture', 'err', {detail: e.message}); }
  });

  async function run() {
    const questions = {};
    let n = 0;
    for (const r of rows) {
      const text = r.text.value.trim();
      if (!text) continue;
      const opts = [...new Set(r.opts.value.split(',').map(x => x.trim()).filter(Boolean))];
      const id = `q${++n}`;
      if (r.type.value === 'noul') questions[id] = {type: 'noul', instructions: text};
      else if (opts.length < 2) { toast(`“${text}” needs at least two ${r.type.value === 'score' ? 'levels' : 'options'}`, 'info'); return; }
      else if (r.type.value === 'choice') questions[id] = {type: 'choice', instructions: text, criteria: Object.fromEntries(opts.slice(0, 32).map(o => [o, null]))};
      else questions[id] = {type: 'score', instructions: text, criteria: opts.slice(0, 10)};
    }
    if (!n) { toast('Add a question first', 'info'); return; }
    if (!state.value.trim() && !image) { toast('Write what the model should decide about, or add a picture', 'info'); return; }
    const model = mp.value;
    if (!(await ensureLoaded(model))) return;
    clear(out).append(loadingBlock('Asking…'));
    const body = {model, state: state.value.trim() || 'A picture.', questions};
    if (image) body.images = [image];
    const t0 = performance.now();
    const r = await dev('/v1/systemone', {method: 'POST', json: body, label: 'Decide', timeout: 300, silent: true});
    const ms = Math.round(performance.now() - t0);
    clear(out);
    if (!r.ok) { out.append(errorBlock(r.error, {title: 'The model couldn’t answer'})); return; }
    const answers = r.json?.answers || {};
    append(out, [Object.entries(questions).map(([id, q]) => answerBlock(q, answers[id])),
      h('p', {class: 'small faint'}, `${fmtSecs(ms / 1000)} · read ${r.json?.usage?.input_tokens ?? '?'} tokens · ${shortName(r.json?.model || model)}`), rawDetails(r.json)]);
  }
  function answerBlock(q, a) {
    const bar = (label, p, best) => h('div', {class: `dq-bar${best ? ' best' : ''}`}, h('span', {class: 'dq-label'}, label), progressBar(p * 100), h('span', {class: 'dq-pct'}, `${Math.round(p * 100)}%`));
    const head = h('strong', {}, q.instructions);
    if (!a) return h('div', {class: 'dq-answer'}, head, h('p', {class: 'muted small'}, 'No answer.'));
    if (q.type === 'noul') {
      const p = num(a.noul) ?? 0;
      return h('div', {class: 'dq-answer'}, head, bar('Yes', p, p >= 0.5), bar('No', 1 - p, p < 0.5));
    }
    const probs = a.probabilities || {};
    if (q.type === 'choice') {
      return h('div', {class: 'dq-answer'}, head, Object.keys(q.criteria).map(k => [k, num(probs[k]) ?? 0]).sort((x, y) => y[1] - x[1]).map(([k, p]) => bar(k, p, k === a.choice)));
    }
    const levels = q.criteria, v = num(a.score);
    const near = v != null ? levels[Math.max(0, Math.min(levels.length - 1, Math.round(v)))] : null;
    return h('div', {class: 'dq-answer'}, head, levels.map((l, i) => bar(l, num(probs[i] ?? probs[String(i)]) ?? 0, l === near)),
      v != null ? h('p', {class: 'small muted'}, `Expected level ${v.toFixed(2)} of ${levels.length - 1}: about “${near}”.`) : null);
  }
  el.append(h('div', {class: 'grid cols-2'},
    card({title: 'Ask a decision model', icon: 'spark'}, h('div', {class: 'form'}, mp.el,
      h('div', {class: 'field'}, h('label', {}, 'Examples'), h('div', {class: 'row wrap gap-sm'}, EXAMPLES.map(ex => h('button', {type: 'button', class: 'chip', onclick: () => useExample(ex)}, ex[0])))),
      h('div', {class: 'field'}, h('label', {}, 'What it decides about'), state,
        h('small', {class: 'hint'}, 'A message, a chat, a review, a document. The model reads it once and answers every question below.')),
      h('div', {class: 'field'}, h('label', {}, 'Picture (optional)'), imgBox, imgInput),
      h('div', {class: 'field'}, h('label', {}, 'Questions'), qList, h('div', {}, btn('Add a question', () => addRow(), {small: true, kind: 'ghost', icon: 'plus'}))),
      h('div', {}, btn('Ask', run, {kind: 'primary', icon: 'play'})))),
    card({title: 'Answers', icon: 'list', sub: 'A probability for every answer, without generating any text'}, out)));
  renderImage();
  useExample(EXAMPLES[0]);
}

/* --------------------------------------------------------------- Connectors */
const CONNECTORS = [
  {id: 'gmail', name: 'Gmail', kind: 'oauth', path: 'gmail', ic: 'mail', cat: 'Email'},
  {id: 'outlook-mail', name: 'Outlook Mail', kind: 'oauth', path: 'outlook', ic: 'mail', cat: 'Email'},
  {id: 'other-mail', name: 'Other email (IMAP/SMTP)', kind: 'email', channel: 'email', ic: 'mail', cat: 'Email'},
  {id: 'google-calendar', name: 'Google Calendar', kind: 'oauth', path: 'calendar', ic: 'calendar', cat: 'Calendar'},
  {id: 'outlook-calendar', name: 'Outlook Calendar', kind: 'oauth', path: 'outlook/calendar', ic: 'calendar', cat: 'Calendar'},
  {id: 'telegram', name: 'Telegram', kind: 'token', channel: 'telegram', ic: 'send', cat: 'Messaging'},
  {id: 'discord', name: 'Discord', kind: 'token', channel: 'discord', ic: 'chat', cat: 'Messaging'},
  {id: 'whatsapp', name: 'WhatsApp', kind: 'whatsapp', channel: 'whatsapp', ic: 'phone', cat: 'Messaging'},
  {id: 'x', name: 'X (Twitter)', kind: 'x', channel: 'x', ic: 'hash', cat: 'Messaging'},
];

function viewConnectors(root, ctx) {
  const state = {channels: null, oauth: {}, mcp: null, error: ''};
  const grid = h('div', {}, loadingBlock('Checking connectors…'));
  const mcpBody = h('div', {}, loadingBlock());
  root.append(
    h('div', {class: 'banner info'}, icon('info'), h('div', {class: 'text'}, h('strong', {}, 'Connectors let your Tiiny read and act on your accounts'),
      h('span', {class: 'small'}, 'Actions with connected accounts run in Task Mode in TiinyOS. Here you connect and disconnect them.'))),
    card({title: 'Accounts and apps', ic: 'plug', actions: [iconBtn('refresh', 'Refresh', () => load())]}, grid),
    card({title: 'Custom MCP servers', ic: 'server', sub: 'Give the device extra tools through the Model Context Protocol',
      actions: [btn('Add server', addMcp, {small: true, icon: 'plus', kind: 'primary'})]}, mcpBody));

  const uidHeaders = () => S.deviceId ? {'X-User-Id': S.deviceId} : {};

  async function load() {
    if (!S.deviceId) await refreshOverview();
    const [st, mcp, ...oauth] = await Promise.all([
      dev('/v1/status', {service: 'connector', quiet: true, silent: true}),
      dev('/v1/mcp/servers', {service: 'connector', quiet: true, silent: true}),
      ...CONNECTORS.filter(c => c.kind === 'oauth').map(c => dev(`/v1/${c.path}/status`, {service: 'connector', headers: uidHeaders(), quiet: true, silent: true})),
    ]);
    if (!ctx.alive()) return;
    state.channels = st.ok ? (st.json?.channels || {}) : null;
    state.error = st.ok ? '' : st.error;
    CONNECTORS.filter(c => c.kind === 'oauth').forEach((c, i) => { state.oauth[c.id] = oauth[i].ok ? oauth[i].json : {error: oauth[i].error}; });
    state.mcp = mcp.ok ? (Array.isArray(mcp.json) ? mcp.json : findArray(mcp.json, ['servers']) || []) : null;
    render();
  }

  function statusOf(c) {
    if (c.kind === 'oauth') {
      const s = state.oauth[c.id] || {};
      if (s.error) return {on: false, text: 'Unavailable', detail: s.error};
      return {on: !!s.connected, text: s.connected ? 'Connected' : 'Not connected', detail: s.email_address || (s.missing_scopes?.length ? `Missing permissions: ${s.missing_scopes.join(', ')}` : '')};
    }
    const ch = state.channels?.[c.channel];
    if (!ch) return {on: false, text: state.channels ? 'Not set up' : 'Unavailable', detail: state.error};
    return {on: !!ch.connected, text: ch.connected ? 'Connected' : ch.running ? 'Waiting' : 'Not connected', detail: ch.detail === 'qr' ? 'Waiting for the QR code to be scanned' : ch.detail};
  }

  function render() {
    clear(grid);
    const cats = [...new Set(CONNECTORS.map(c => c.cat))];
    grid.append(h('div', {class: 'stack'}, cats.map(cat => h('div', {class: 'stack-sm'}, h('div', {class: 'section-title'}, cat),
      h('div', {class: 'grid cols-3'}, CONNECTORS.filter(c => c.cat === cat).map(c => {
        const st = statusOf(c);
        return h('div', {class: `conn-card ${st.on ? 'on' : ''}`},
          h('div', {class: 'conn-head'}, h('span', {class: 'icon-box'}, icon(c.ic)), h('div', {class: 'spacer', style: {minWidth: 0}}, h('strong', {}, c.name), h('span', {class: 'small muted ellipsis', style: {display: 'block'}, title: st.detail || ''}, st.detail || '')),
            badge(st.text, st.on ? 'ok' : st.text === 'Waiting' ? 'accent' : '')),
          h('div', {class: 'row'}, st.on ? btn('Disconnect', () => disconnect(c), {small: true, kind: 'ghost', icon: 'x'}) : btn('Connect', () => connect(c), {small: true, kind: 'primary', icon: 'link'})));
      }))))));
    clear(mcpBody);
    if (state.mcp === null) { mcpBody.append(h('p', {class: 'muted'}, 'Couldn’t list MCP servers.')); return; }
    if (!state.mcp.length) { mcpBody.append(emptyState('server', 'No custom MCP servers', 'Add one to give the device new tools, such as search or your own APIs.')); return; }
    mcpBody.append(h('div', {class: 'stack-sm'}, state.mcp.map(s => {
      const id = pick(s, 'id', 'server_id', 'connector_id', 'name');
      const name = pick(s, 'name', 'display_name', 'id') || id;
      const statusEl = h('span', {class: 'small muted'});
      return h('div', {class: 'net'}, icon('server'), h('div', {class: 'spacer', style: {minWidth: 0}}, h('strong', {}, name), h('div', {class: 'cell-sub'}, [id, pick(s, 'runEnvironment', 'run_environment', 'type')].filter(Boolean).join(' · ')), statusEl),
        btn('Check', async () => { const r = await dev(`/v1/mcp/servers/${encodeURIComponent(id)}/check`, {service: 'connector', label: `Check ${name}`, silent: true}); statusEl.textContent = r.ok ? `Status: ${pick(r.json || {}, 'status', 'state', 'connected') ?? 'OK'}` : `Problem: ${r.error}`; }, {small: true, kind: 'ghost'}),
        iconBtn('trash', 'Remove', () => removeMcp(id, name)));
    })));
  }

  async function connect(c) {
    if (c.kind === 'oauth') return oauthConnect(c);
    if (c.kind === 'whatsapp') {
      return openTerminal({args: ['connector', 'connect', 'whatsapp'], title: 'Connect WhatsApp',
        hint: 'Scan the QR code with WhatsApp on your phone (Settings → Linked devices). Press R to refresh it, Q to cancel.', onExit: () => load()});
    }
    if (c.kind === 'token') {
      const v = await formDialog({title: `Connect ${c.name}`, submitLabel: 'Connect',
        intro: c.id === 'telegram' ? 'Create a bot with @BotFather in Telegram and paste its token.' : 'Create a bot in the Discord Developer Portal and paste its token.',
        fields: [{name: 'token', label: 'Bot token', type: 'password', required: true, autocomplete: 'off'}]});
      if (!v) return;
      const chk = await dev(`/v1/${c.channel}/check-with-token`, {service: 'connector', method: 'POST', json: {token: v.token, enabled: true}, label: `Verify ${c.name} token`});
      if (!chk.ok) return;
      const r = await dev(`/v1/config/${c.channel}`, {service: 'connector', method: 'PATCH', json: {token: v.token, enabled: true}, label: `Connect ${c.name}`});
      if (r.ok) toast(`${c.name} connected`, 'ok');
      return load();
    }
    if (c.kind === 'x') {
      const v = await formDialog({title: 'Connect X', submitLabel: 'Connect', intro: 'Copy the auth_token and ct0 cookies from a logged-in x.com session in your browser’s developer tools.',
        fields: [{name: 'auth_token', label: 'auth_token', type: 'password', required: true}, {name: 'ct0', label: 'ct0', type: 'password', required: true}]});
      if (!v) return;
      const body = {auth_token: v.auth_token, ct0: v.ct0, enabled: true};
      const chk = await dev('/v2/x/check-with-token', {service: 'connector', method: 'POST', json: body, label: 'Verify X tokens'});
      if (!chk.ok) return;
      const r = await dev('/v1/config/x', {service: 'connector', method: 'PATCH', json: body, label: 'Connect X'});
      if (r.ok) toast('X connected', 'ok');
      return load();
    }
    if (c.kind === 'email') {
      const v = await formDialog({title: 'Connect an email account', submitLabel: 'Verify and connect', size: 'wide',
        intro: 'Use an app password or authorization code from your email provider, not your normal password.',
        fields: [
          {name: 'email', label: 'Email address', type: 'email', required: true},
          {name: 'code', label: 'App password / authorization code', type: 'password', required: true},
          {name: 'imap_host', label: 'IMAP server', placeholder: 'imap.example.com', required: true},
          {name: 'imap_port', label: 'IMAP port', type: 'number', value: 993},
          {name: 'smtp_host', label: 'SMTP server', placeholder: 'smtp.example.com', required: true},
          {name: 'smtp_port', label: 'SMTP port', type: 'number', value: 587},
        ]});
      if (!v) return;
      const chk = await dev('/v1/email/imap/verify', {service: 'connector', method: 'POST', label: 'Verify email login',
        json: {imap_username: v.email, imap_password: v.code, imap_host: v.imap_host, imap_port: Number(v.imap_port) || 993}});
      if (!chk.ok) return;
      const r = await dev('/v1/config/email', {service: 'connector', method: 'PATCH', label: 'Connect email', json: {enabled: true,
        imap_username: v.email, imap_password: v.code, imap_host: v.imap_host, imap_port: Number(v.imap_port) || 993,
        smtp_host: v.smtp_host, smtp_port: Number(v.smtp_port) || 587, smtp_username: v.email, smtp_password: v.code}});
      if (r.ok) toast('Email connected', 'ok');
      return load();
    }
  }

  async function oauthConnect(c) {
    const r = await dev(`/v1/${c.path}/auth-url`, {service: 'connector', headers: uidHeaders(), label: `Connect ${c.name}`});
    if (!r.ok) return;
    const url = findUrl(r.json) || (r.text || '').trim();
    if (!/^https?:\/\//.test(url)) { toast('The device didn’t return a sign-in link', 'err', {detail: JSON.stringify(r.json)}); return; }
    window.open(url, '_blank', 'noopener');
    const status = h('div', {class: 'row gap-sm muted'}, h('span', {class: 'spinner'}), 'Waiting for you to approve access…');
    let stopped = false;
    const m = modal({title: `Connect ${c.name}`, onClose: () => { stopped = true; },
      body: h('div', {class: 'stack'}, h('p', {}, 'A sign-in page opened in a new tab. Approve access there and this window updates automatically.'),
        h('div', {class: 'copy-row'}, h('input', {class: 'input', readOnly: true, value: url}), iconBtn('copy', 'Copy link', () => copyText(url, 'Link copied'), {kind: '', small: false}),
          h('a', {class: 'btn', href: url, target: '_blank', rel: 'noopener noreferrer'}, 'Open')), status)});
    const until = Date.now() + 5 * 60 * 1000;
    while (!stopped && Date.now() < until) {
      await sleep(3000);
      const s = await dev(`/v1/${c.path}/status`, {service: 'connector', headers: uidHeaders(), quiet: true, silent: true});
      if (s.ok && s.json?.connected) { m.close(); toast(`${c.name} connected${s.json.email_address ? ` as ${s.json.email_address}` : ''}`, 'ok'); load(); return; }
    }
    if (!stopped) { clear(status).append(icon('alert'), 'Still not connected. Close this window and try again.'); }
  }

  async function disconnect(c) {
    if (!(await confirmDialog({title: `Disconnect ${c.name}?`, message: 'Its stored credentials are removed from your Tiiny.', confirmLabel: 'Disconnect', danger: true}))) return;
    let r;
    if (c.kind === 'oauth') r = await dev(`/v1/${c.path}/connection`, {service: 'connector', method: 'DELETE', headers: uidHeaders(), label: `Disconnect ${c.name}`});
    else if (c.kind === 'token') r = await dev(`/v1/config/channels/${c.channel}`, {service: 'connector', method: 'PATCH', json: {token: '', enabled: false}, label: `Disconnect ${c.name}`});
    else if (c.kind === 'x') r = await dev('/v1/config/channels/x', {service: 'connector', method: 'PATCH', label: 'Disconnect X', json: {token: '', auth_token: '', ct0: '', cookie_string: '', cookie_source: '', enabled: false}});
    else if (c.kind === 'email') r = await dev('/v1/config/channels/email', {service: 'connector', method: 'PATCH', label: 'Disconnect email', json: {smtp_host: '', smtp_username: '', smtp_password: '', smtp_from: '', imap_host: '', imap_username: '', imap_password: '', enabled: false}});
    else if (c.kind === 'whatsapp') r = await dev('/v1/whatsapp/bridge/logout', {service: 'connector', method: 'POST', label: 'Disconnect WhatsApp'});
    if (r?.ok) toast(`${c.name} disconnected`, 'ok');
    load();
  }

  async function addMcp() {
    const tabs = {mode: 'form'};
    const body = h('div', {class: 'stack'});
    const name = h('input', {class: 'input', placeholder: 'my-search'});
    const type = h('select', {class: 'input'}, [['streamable_http', 'Streamable HTTP'], ['sse', 'Server-sent events (SSE)'], ['stdio', 'Local command (stdio)']].map(([v, l]) => h('option', {value: v}, l)));
    const url = h('input', {class: 'input', placeholder: 'https://example.com/mcp'});
    const command = h('input', {class: 'input', placeholder: 'npx -y @modelcontextprotocol/server-everything'});
    const headers = h('textarea', {class: 'input', rows: 3, placeholder: 'Authorization: Bearer abc123\nX-Other-Header: value'});
    const runOn = h('select', {class: 'input'}, h('option', {value: 'Computer'}, 'This computer'), h('option', {value: 'Tiiny'}, 'The Tiiny device'));
    const json = h('textarea', {class: 'input mono', rows: 12, spellcheck: 'false'});
    json.value = JSON.stringify({mcpServers: {'remote-search': {type: 'streamable_http', baseUrl: 'https://example.com/mcp', headers: {Authorization: 'Bearer token'}}}}, null, 2);
    const urlField = h('div', {class: 'field'}, h('label', {}, 'Server URL'), url);
    const cmdField = h('div', {class: 'field', hidden: true}, h('label', {}, 'Command'), command, h('small', {class: 'hint'}, 'The command and its arguments, as you would type them in a shell.'));
    type.addEventListener('change', () => { const stdio = type.value === 'stdio'; urlField.hidden = stdio; cmdField.hidden = !stdio; });
    const formPane = h('div', {class: 'form'}, h('div', {class: 'form-row'}, h('div', {class: 'field'}, h('label', {}, 'Name'), name), h('div', {class: 'field'}, h('label', {}, 'Type'), type)),
      urlField, cmdField, h('div', {class: 'field'}, h('label', {}, 'Headers (optional)'), headers),
      h('div', {class: 'field'}, h('label', {}, 'Run the server on'), runOn, h('small', {class: 'hint'}, 'This can’t be changed after saving.')));
    const jsonPane = h('div', {class: 'form', hidden: true}, h('p', {class: 'muted small'}, 'Paste a standard MCP config with an mcpServers object (the format Claude Desktop and Cursor use).'), json);
    const seg = segmented([['form', 'Fill in a form'], ['json', 'Paste JSON']], 'form', v => { tabs.mode = v; formPane.hidden = v !== 'form'; jsonPane.hidden = v !== 'json'; });
    body.append(seg, formPane, jsonPane);
    const save = btn('Add server', async () => {
      let r;
      if (tabs.mode === 'json') {
        let cfg;
        try { cfg = JSON.parse(json.value); } catch (e) { toast('That isn’t valid JSON', 'err', {detail: e.message}); return; }
        r = await dev('/v1/mcp/servers/import-json', {service: 'connector', method: 'POST', json: cfg, label: 'Import MCP config'});
      } else {
        const n = name.value.trim();
        if (!n) { name.focus(); toast('Give the server a name', 'info'); return; }
        const hdrs = {};
        for (const line of headers.value.split('\n')) { const i = line.indexOf(':'); if (i > 0) hdrs[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
        let server;
        if (type.value === 'stdio') {
          const parts = command.value.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
          if (!parts.length) { command.focus(); return; }
          server = {type: 'stdio', command: parts[0], args: parts.slice(1).map(p => p.replace(/^["']|["']$/g, ''))};
        } else {
          if (!/^https?:\/\//.test(url.value.trim())) { url.focus(); toast('Enter the server URL', 'info'); return; }
          server = {type: type.value, baseUrl: url.value.trim()};
        }
        if (Object.keys(hdrs).length) server.headers = hdrs;
        r = await dev('/v1/mcp/servers', {service: 'connector', method: 'POST', json: {config: {mcpServers: {[n]: server}}, runEnvironment: runOn.value}, label: `Add MCP server ${n}`});
      }
      if (r.ok) { toast('MCP server added', 'ok'); m.close(); load(); }
    }, {kind: 'primary'});
    const m = modal({title: 'Add a custom MCP server', body, size: 'wide', actions: [h('button', {class: 'btn ghost', type: 'button', onclick: () => m.close()}, 'Cancel'), save]});
  }

  async function removeMcp(id, name) {
    if (!(await confirmDialog({title: `Remove ${name}?`, message: 'The device stops using this MCP server.', confirmLabel: 'Remove', danger: true}))) return;
    const r = await dev(`/v1/mcp/servers/${encodeURIComponent(id)}`, {service: 'connector', method: 'DELETE', label: `Remove MCP server ${name}`});
    if (r.ok) toast('Removed', 'ok');
    load();
  }

  load();
}

/* ------------------------------------------------------------------ Network */
function viewNetwork(root, ctx) {
  const wifiBody = h('div', {}, loadingBlock());
  const netsBody = h('div');
  const devBody = h('div');
  root.append(
    card({title: 'Wi-Fi', ic: 'wifi', sub: 'The device needs internet access to download models, update, and use connectors', actions: [iconBtn('refresh', 'Refresh', () => loadWifi())]},
      h('div', {class: 'stack'}, wifiBody, netsBody)),
    card({title: 'Which Tiiny this panel uses', ic: 'cpu', actions: [btn('Scan for devices', () => scan(), {small: true, icon: 'scan', kind: 'primary'})]}, devBody));

  async function loadWifi() {
    const r = await dev('/api/v1/sys/wifi/connection_status', {service: 'wifi', quiet: true, silent: true});
    if (!ctx.alive()) return;
    clear(wifiBody);
    if (!r.ok) { wifiBody.append(errorBlock(r.error, {retry: loadWifi, title: 'Couldn’t read Wi-Fi status'})); return; }
    const w = r.json || {};
    const sw = switchInput(!!w.enabled, async on => {
      const res = await dev('/api/v1/sys/wifi/connection_switch', {service: 'wifi', method: 'POST', json: {enabled: on}, label: `Turn Wi-Fi ${on ? 'on' : 'off'}`});
      if (res.ok) toast(`Wi-Fi turned ${on ? 'on' : 'off'}`, 'ok');
      setTimeout(loadWifi, 1500);
    }, 'Wi-Fi');
    wifiBody.append(h('div', {class: 'stack'},
      h('div', {class: 'row'}, sw, h('strong', {}, w.enabled ? 'Wi-Fi is on' : 'Wi-Fi is off'), h('span', {class: 'spacer'}),
        w.is_connected ? badge(`Connected to ${w.connected_wifi_name}`, 'ok', 'check') : w.enabled ? badge('Not connected', 'warn') : null),
      kvList([['Network', w.connected_wifi_name], ['Signal', w.is_connected && w.signal_strength != null ? `${w.signal_strength}${Math.abs(w.signal_strength) > 100 ? '' : w.signal_strength < 0 ? ' dBm' : '%'}` : null],
        ['IP address', w.ipv4_address || w.ip_address], ['IPv6', (w.ipv6_addresses || []).join(', ') || null], ['Error', w.error]]),
      h('div', {class: 'row wrap'},
        w.enabled ? btn('Find networks', () => listNetworks(), {icon: 'search'}) : null,
        w.is_connected ? btn('Disconnect', async () => {
          if (!(await confirmDialog({title: `Disconnect from ${w.connected_wifi_name}?`, message: 'If this panel reaches the device over Wi-Fi, you’ll lose the connection until it reconnects.', confirmLabel: 'Disconnect', danger: true}))) return;
          const res = await dev('/api/v1/sys/wifi/wifi_disconnect', {service: 'wifi', method: 'POST', json: {wifi_name: w.connected_wifi_name}, label: 'Disconnect Wi-Fi'});
          if (res.ok) toast('Disconnected', 'ok');
          loadWifi();
        }, {kind: 'ghost', icon: 'x'}) : null,
        btn('Use the CLI wizard', () => openTerminal({args: ['wifi', 'connect'], title: 'Connect to Wi-Fi', onExit: () => loadWifi()}), {kind: 'ghost', icon: 'terminal'}))));
  }

  async function listNetworks() {
    clear(netsBody).append(loadingBlock('Scanning for networks (this can take a few seconds)…'));
    const r = await dev('/api/v1/sys/wifi/wifi_list', {service: 'wifi', quiet: true, silent: true, timeout: 60});
    clear(netsBody);
    if (!r.ok) { netsBody.append(errorBlock(r.error, {title: 'Scan failed'})); return; }
    const nets = (Array.isArray(r.json) ? r.json : findArray(r.json, ['wifi_list', 'networks', 'list']) || [])
      .map(n => typeof n === 'string' ? {name: n} : {name: pick(n, 'wifi_name', 'ssid', 'name'), signal: num(pick(n, 'signal_strength', 'signal', 'rssi', 'quality', 'strength')),
        secure: pick(n, 'security', 'encryption', 'auth', 'flags', 'need_password'), connected: !!pick(n, 'connected', 'is_connected', 'active'), raw: n})
      .filter(n => n.name).sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999));
    if (!nets.length) { netsBody.append(emptyState('wifi', 'No networks found', 'Move the device closer to your router and try again.'), rawDetails(r.json)); return; }
    const bars = s => { const lvl = s === null ? 0 : s < 0 ? (s > -55 ? 4 : s > -65 ? 3 : s > -75 ? 2 : 1) : (s > 75 ? 4 : s > 50 ? 3 : s > 25 ? 2 : 1); return h('span', {class: 'sig'}, [1, 2, 3, 4].map(i => h('i', {class: i <= lvl ? 'on' : '', style: {height: `${i * 3 + 2}px`}}))); };
    netsBody.append(h('div', {class: 'net-list'}, nets.map(n => h('div', {class: 'net'}, bars(n.signal), h('strong', {class: 'spacer'}, n.name),
      n.secure && n.secure !== 'false' && n.secure !== false ? badge('Secured', '', 'key') : badge('Open'),
      n.connected ? badge('Connected', 'ok') : btn('Connect', () => joinNetwork(n), {small: true, kind: 'primary'})))));
  }

  async function joinNetwork(n) {
    const v = await formDialog({title: `Join ${n.name}`, submitLabel: 'Connect', fields: [{name: 'password', label: 'Password', type: 'password', hint: 'Leave empty for open networks.'}]});
    if (!v) return;
    const r = await dev('/api/v1/sys/wifi/wifi_connect', {service: 'wifi', method: 'POST', json: {wifi_name: n.name, password: v.password}, label: `Connect to ${n.name}`, timeout: 90});
    if (r.ok) toast(`Connecting to ${n.name}…`, 'ok');
    clear(netsBody);
    setTimeout(loadWifi, 2500);
  }

  function renderDevice(found) {
    clear(devBody);
    const conn = S.health?.device || {};
    devBody.append(h('div', {class: 'stack'},
      kvList([['Current address', conn.address ? h('code', {}, conn.address) : 'not set'], ['Comes from', conn.sources?.address || null], ['API key', conn.key_set ? `${conn.key_hint} (${conn.sources?.key})` : 'missing']]),
      found === undefined ? null : found === null ? loadingBlock('Looking for Tiiny devices on your network and USB-C…') : !found.length
        ? h('p', {class: 'muted'}, 'No devices answered. Check the device is on and connected, or enter its address below.')
        : h('div', {class: 'net-list'}, found.map(d => {
          const addrs = [...new Set([...(d.addresses || []), d.usb?.active ? d.usb.device_ip : null].filter(Boolean))];
          return h('div', {class: 'net'}, icon('cpu'), h('div', {class: 'spacer'}, h('strong', {}, d.device_name || d.hostname || 'Tiiny'), h('div', {class: 'cell-sub'}, [d.serial_number, (d.transport || []).join('/')].filter(Boolean).join(' · '))),
            addrs.map(a => a === conn.address ? badge(`${a} · in use`, 'ok') : btn(`Use ${a}`, () => useAddress(a), {small: true})));
        })),
      h('form', {class: 'row wrap', onsubmit: e => { e.preventDefault(); const v = e.target.elements.addr.value.trim(); if (v) useAddress(v); }},
        h('input', {class: 'input', name: 'addr', placeholder: 'Device IP address, e.g. 192.168.1.50', style: {maxWidth: '320px'}}), btn('Connect', null, {type: 'submit'})),
      h('p', {class: 'muted small'}, 'Connecting runs “tiiny connect <address>”, so the CLI and this panel stay in sync.')));
  }

  async function scan() {
    renderDevice(null);
    let found = [];
    try { found = (await api('/api/discover?wait=2')).devices || []; } catch (e) { toast('Scan failed', 'err', {detail: e.message}); }
    if (ctx.alive()) renderDevice(found);
  }

  async function useAddress(addr) {
    const r = await cli(['connect', addr], {label: `Connect to ${addr}`, timeout: 60});
    if (!r.ok) return;
    toast(`Now using ${addr}`, 'ok', {detail: (r.stdout || '').trim()});
    await refreshHealth();
    await refreshOverview();
    refreshModels();
    renderDevice(undefined);
    if (S.state === 'login' || S.state === 'locked') { const go2 = await confirmDialog({title: 'Log in to this device?', message: S.state === 'locked' ? 'This device is locked. Log in to unlock it before the panel can use it.' : 'This device needs you to log in before the panel can use it.', confirmLabel: 'Log in'}); if (go2) loginDialog(); }
  }

  loadWifi();
  (S.health ? Promise.resolve() : refreshHealth()).then(() => ctx.alive() && renderDevice(undefined));
}

/* ------------------------------------------------------------------ Account */
function viewAccount(root, ctx) {
  const acctBody = h('div', {}, loadingBlock());
  const keyBody = h('div');
  const profileBody = h('div', {}, loadingBlock());
  root.append(
    h('div', {class: 'grid cols-2'},
      card({title: 'Account', ic: 'user'}, acctBody),
      card({title: 'API access', ic: 'key', sub: 'Use your Tiiny from other apps with an OpenAI-compatible client'}, keyBody)),
    card({title: 'Personalization profile', ic: 'brain', sub: 'Tells the device about you. It is used in Task Mode in TiinyOS, and here in Chat when “Use my profile” is on.'}, profileBody));

  async function loadAccount() {
    const o = S.overview || await refreshOverview();
    const info = await cli(['auth', 'info'], {quiet: true, silent: true, timeout: 30});
    if (!ctx.alive()) return;
    const acct = o?.account?.json || {};
    const kv = info.ok ? (info.kv || {}) : {};
    const term = (args, title, hint, after) => () => openTerminal({args, title, hint, onExit: code => { if (code === 0) { refreshHealth(); refreshOverview().then(() => ctx.alive() && loadAccount()); if (after) after(); } }});
    clear(acctBody).append(h('div', {class: 'stack'},
      kvList([['Username', acct.user_info?.user_name || kv.Username], ['Email', kv.Email || h('span', {class: 'muted'}, 'none bound')], ['Device', acct.user_info?.device_name],
        ['Device ID', acct.device_id], ['Signed in', S.health?.device?.key_set ? `yes (key from ${S.health.device.sources.key})` : 'no']]),
      h('div', {class: 'row wrap'},
        btn('Log in', () => loginDialog({onDone: () => ctx.alive() && loadAccount()}), {kind: 'primary', icon: 'login', small: true}),
        btn('Log out', async () => {
          if (!(await confirmDialog({title: 'Log out?', message: 'This removes the saved API key from the tiiny CLI on this computer. The panel stops working until you log in again.', confirmLabel: 'Log out', danger: true}))) return;
          const r = await cli(['logout'], {label: 'Log out'});
          if (r.ok) { toast('Logged out', 'ok'); refreshHealth(); refreshOverview(); loadAccount(); }
        }, {icon: 'logout', small: true}),
        btn('Activate a new device', activateTerminal, {kind: 'ghost', small: true})),
      h('div', {class: 'section-title'}, 'Change account details'),
      h('div', {class: 'row wrap'},
        btn('Username', term(['auth', 'username'], 'Change username'), {small: true, icon: 'edit', kind: 'ghost'}),
        btn('Password', term(['auth', 'passwd'], 'Change password', 'You need your current password.'), {small: true, icon: 'key', kind: 'ghost'}),
        btn('Forgot password', term(['auth', 'forgot-passwd'], 'Reset password', 'A verification code is sent to your bound email.'), {small: true, icon: 'mail', kind: 'ghost'}),
        btn(kv.Email ? 'Change email' : 'Bind email', term([kv.Email ? 'auth' : 'auth', kv.Email ? 'email-update' : 'email-bind'], kv.Email ? 'Change email' : 'Bind an email', 'You’ll get a verification code by email.'), {small: true, icon: 'mail', kind: 'ghost'}),
        kv.Email ? btn('Unbind email', term(['auth', 'email-unbind'], 'Unbind email'), {small: true, icon: 'x', kind: 'ghost'}) : null)));
  }

  function renderKey() {
    const conn = S.health?.device || {};
    const addr = conn.address || '<device-ip>';
    const base = `http://${addr.includes(':') ? `[${addr}]` : addr}/v1`;
    const keyInput = h('input', {class: 'input', readOnly: true, value: conn.key_set ? conn.key_hint : 'No key yet. Log in first.'});
    let revealed = '';
    const snippet = `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}", api_key="YOUR_KEY")\nreply = client.chat.completions.create(\n    model="default",\n    messages=[{"role": "user", "content": "Hello from my Tiiny"}],\n)\nprint(reply.choices[0].message.content)`;
    clear(keyBody).append(h('div', {class: 'stack'},
      h('div', {class: 'field'}, h('label', {}, 'API key'), h('div', {class: 'copy-row'}, keyInput,
        conn.key_set ? iconBtn('eye', 'Reveal', async () => { if (!revealed) revealed = (await api('/api/device/key')).key; keyInput.value = keyInput.value === revealed ? conn.key_hint : revealed; }, {kind: '', small: false}) : null,
        conn.key_set ? iconBtn('copy', 'Copy key', async () => { if (!revealed) revealed = (await api('/api/device/key')).key; copyText(revealed, 'API key copied'); }, {kind: '', small: false}) : null)),
      h('div', {class: 'field'}, h('label', {}, 'OpenAI-compatible base URL'), h('div', {class: 'copy-row'}, h('input', {class: 'input', readOnly: true, value: base}), iconBtn('copy', 'Copy', () => copyText(base, 'Base URL copied'), {kind: '', small: false})),
        h('small', {class: 'hint'}, 'Chat, embeddings, images, speech and transcription. The model ID “default” uses whatever is loaded.')),
      h('div', {class: 'code-block'}, iconBtn('copy', 'Copy code', () => copyText(snippet, 'Code copied')), snippet),
      h('p', {class: 'muted small'}, 'Anthropic- and Ollama-compatible endpoints exist too; see the ', h('a', {href: `${DOCS_URL}#/inference`, target: '_blank', rel: 'noopener'}, 'inference docs'), '.')));
  }

  async function loadProfile() {
    const r = await dev('/kb/user-context', {service: 'kb', quiet: true, silent: true});
    const ver = await dev('/kb/user-context/versions', {service: 'kb', query: {limit: 1}, quiet: true, silent: true});
    if (!ctx.alive()) return;
    clear(profileBody);
    if (!r.ok) { profileBody.append(errorBlock(r.error, {retry: loadProfile, title: 'Couldn’t load your profile'})); return; }
    const p = r.json?.profile || {};
    const v = findArray(ver.json, ['versions']) || [];
    const latest = v[0] || null;
    const fields = [['occupation', 'Occupation', 50, 2, 'e.g. Security engineer at a fintech start-up'],
      ['preferences', 'Preferences', 1000, 4, 'How you like answers: tone, length, language, things to avoid…'],
      ['more_about_you', 'More about you', 1000, 4, 'Anything else the assistant should know.']];
    profileBody.append(h('div', {class: 'stack'},
      latest ? h('p', {class: 'muted small'}, `Last changed ${fmtAgo(pick(latest, 'created_at', 'updated_at', 'timestamp'))}${pick(latest, 'changed_by', 'source') ? ` by ${pick(latest, 'changed_by', 'source')}` : ''}. Manual edits aren’t overwritten by automatic summaries.`) : null,
      fields.map(([key, label, max, rows, ph]) => {
        const ta = h('textarea', {class: 'input', rows, maxlength: max, placeholder: ph});
        ta.value = p[key] || '';
        const counter = h('span', {class: 'counter'});
        const upd = () => { counter.textContent = `${ta.value.length} / ${max}`; };
        ta.addEventListener('input', upd);
        upd();
        const save = btn('Save', async () => {
          const res = await dev(`/kb/user-context/profile/${key}`, {service: 'kb', method: 'PATCH', json: {value: ta.value.trim()}, label: `Save ${label.toLowerCase()}`});
          if (res.ok) toast(`${label} saved`, 'ok');
        }, {small: true, kind: 'primary'});
        const clr = btn('Clear', async () => {
          const res = await dev(`/kb/user-context/profile/${key}`, {service: 'kb', method: 'PATCH', json: {value: ''}, label: `Clear ${label.toLowerCase()}`});
          if (res.ok) { ta.value = ''; upd(); toast(`${label} cleared`, 'ok'); }
        }, {small: true, kind: 'ghost'});
        return h('div', {class: 'field'}, h('label', {}, label, counter), ta, h('div', {class: 'row gap-sm'}, save, clr));
      })));
  }

  (S.health ? Promise.resolve() : refreshHealth()).then(() => { if (ctx.alive()) { renderKey(); loadAccount(); } });
  loadProfile();
}

/* ----------------------------------------------------------------- Terminal */
function viewTerminal(root, ctx) {
  if (S.health && !S.health.cli.found) { root.append(cliMissingCard()); return; }
  const input = h('input', {class: 'input mono', placeholder: 'status', 'aria-label': 'tiiny command', autocomplete: 'off', spellcheck: 'false'});
  const history = (() => { try { return JSON.parse(localStorage.getItem('tiiny.cmdHistory') || '[]'); } catch { return []; } })();
  let hIndex = -1;
  const run = line => {
    line = line.trim().replace(/^tiiny\s+/, '');
    if (!line) return;
    const i = history.indexOf(line);
    if (i >= 0) history.splice(i, 1);
    history.unshift(line);
    history.length = Math.min(history.length, 30);
    try { localStorage.setItem('tiiny.cmdHistory', JSON.stringify(history)); } catch { /* ignore */ }
    hIndex = -1;
    openTerminal({line, title: `tiiny ${line}`});
    renderHistory();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' && history.length) { e.preventDefault(); hIndex = Math.min(hIndex + 1, history.length - 1); input.value = history[hIndex]; }
    else if (e.key === 'ArrowDown') { e.preventDefault(); hIndex = Math.max(hIndex - 1, -1); input.value = hIndex >= 0 ? history[hIndex] : ''; }
  });
  const historyEl = h('div', {class: 'row wrap gap-sm'});
  const renderHistory = () => { append(clear(historyEl), history.slice(0, 10).map(l => h('button', {class: 'chip', type: 'button', onclick: () => run(l)}, h('span', {class: 'mono'}, l)))); };
  const quick = [
    ['Device status', 'status', 'gauge'], ['Live NPU monitor', 'top', 'activity'], ['Loaded models', 'ls -l', 'box'], ['Model store', 'ls -r', 'download'],
    ['Log in', 'login', 'login'], ['Activate device', 'init', 'shield'], ['Scan for devices', 'scan', 'scan'], ['Wi-Fi wizard', 'wifi connect', 'wifi'],
    ['Vault files', 'vault ls', 'folder'], ['Connectors', 'connector ls', 'plug'], ['Downloads', 'downloads ls', 'download'], ['All commands', '--help', 'book'],
  ];
  const sessionsEl = h('div');
  const renderSessions = () => {
    clear(sessionsEl);
    if (!Terms.size) { sessionsEl.append(h('p', {class: 'muted small'}, 'Commands you run open in a terminal window. Hidden ones keep running and are listed here.')); return; }
    sessionsEl.append(h('div', {class: 'stack-sm'}, [...Terms.values()].reverse().map(s => h('div', {class: 'net'}, icon('terminal'), h('div', {class: 'spacer', style: {minWidth: 0}}, h('strong', {}, s.title), h('div', {class: 'cell-sub ellipsis'}, s.cmd)),
      badge(s.running ? 'Running' : s.code === 0 ? 'Finished' : `Exited ${s.code}`, s.running ? 'accent' : s.code === 0 ? 'ok' : 'err'), btn('Show', () => showTerminal(s), {small: true})))));
  };
  root.append(
    card({title: 'Run a tiiny command', ic: 'terminal', sub: `Uses ${S.health?.cli?.path || 'the tiiny CLI'}${S.health?.cli?.version ? ` (${S.health.cli.version})` : ''}`},
      h('form', {class: 'stack', onsubmit: e => { e.preventDefault(); run(input.value); input.value = ''; }},
        h('div', {class: 'row'}, h('span', {class: 'mono muted'}, 'tiiny'), input, btn('Run', null, {kind: 'primary', icon: 'play', type: 'submit'})),
        historyEl)),
    card({title: 'Common commands', ic: 'bolt'}, h('div', {class: 'quick-grid'}, quick.map(([label, line, ic]) => h('button', {class: 'quick', type: 'button', onclick: () => run(line)}, icon(ic), h('strong', {}, label), h('small', {class: 'mono'}, `tiiny ${line}`))))),
    card({title: 'Terminal windows', ic: 'list'}, sessionsEl));
  renderHistory();
  renderSessions();
  ctx.every(1500, renderSessions);
}

function cliMissingCard() {
  const cmd = S.health?.cli?.install_cmd || 'curl -fsSL "https://tiiny-cli.tiiny.cloud/install-linux.sh" | bash && source ~/.profile';
  return card({title: 'The tiiny CLI isn’t installed', ic: 'terminal'}, h('div', {class: 'stack'},
    h('p', {}, 'Most of this panel talks to your device directly, but logging in, activation, benchmarks and backups use the official CLI. Install it in a terminal:'),
    h('div', {class: 'code-block'}, iconBtn('copy', 'Copy', () => copyText(cmd, 'Command copied')), cmd),
    h('p', {class: 'muted small'}, 'Then reload this page. If it is installed somewhere unusual, start the panel with python3 tiiny_ui.py --tiiny PATH.')));
}

/* System → Firmware: TiinyOS updates through the device's own upgrade service (tiinyui/firmware.py). The tiiny
   CLI's `upgrade` gets HTTP 404 from the new upgrade service on TiinyOS 0.1.38, so the CLI is only the fallback for
   devices without it. Install = the panel's server downloads the update to the device, then installs it (the device
   only installs what it downloaded and verified first); this card follows both, through the restart. */
function firmwareCard(ctx) {
  const body = h('div', {class: 'stack'}, loadingBlock('Checking your Tiiny’s version…'));
  let st = null, outcome = null, polling = false, up = null;
  let phase = 'idle', since = 0, sawDown = false;   // 'starting': Install was pressed; 'restarting': Restart now was pressed
  let upId = '', watchId = '', target = '', lostSince = 0;   // the panel's update (download, then install); a device job started elsewhere
  const running = u => u?.status === 'running';
  const viaCli = () => btn('Check for updates', () => openTerminal({args: ['upgrade'], title: 'Firmware upgrade',
    hint: 'The CLI checks for a new version and asks before installing it.'}), {icon: 'download'});
  const loginHint = () => h('p', {class: 'small muted'}, 'If your Tiiny asks you to log in after it restarts, log in under ',
    h('a', {href: '#/account'}, 'Account'), '; the update then finishes by itself.');

  async function load() {
    if (polling) return;   // the last check is still on its way (the device can be slow while it restarts)
    polling = true;
    try { apply(await api(`/api/firmware${watchId ? `?job=${encodeURIComponent(watchId)}` : ''}`)); }
    finally { polling = false; }
  }
  function apply(next) {
    if (!ctx.alive()) return;
    up = next.updater || null;
    if (running(up)) { upId = up.id; target = up.version || target; if (phase === 'starting') phase = 'idle'; }
    else if (upId && up?.id === upId) {   // the update this panel ran has finished
      upId = '';
      outcome = up.status === 'done' ? {state: 'SUCCEEDED', text: 'Update installed', target_version: up.version, error: ''}
        : up.status === 'cancelled' ? {state: 'CANCELED', text: 'Update stopped', error: ''}
        : {state: 'FAILED', text: 'The update failed', error: up.error || ''};
    }
    if (next.reachable === false && (phase !== 'idle' || upId || watchId)) {   // gone in the middle of an update
      lostSince = lostSince || Date.now();
      if (phase === 'restarting') sawDown = true;
      render();
      return;
    }
    lostSince = 0;
    st = next;
    if (next.job?.active && !upId) {   // an update started elsewhere (the device's own dashboard, the CLI)
      watchId = next.job.id;
      target = next.job.target_version || target;
      if (phase === 'starting') phase = 'idle';
    } else if (watchId && !next.job?.active) {
      const fin = next.finished_job && !next.finished_job.active ? next.finished_job
        : target && next.current === target ? {state: 'SUCCEEDED', text: 'Update installed', target_version: target, error: ''} : null;
      watchId = '';
      if (fin && !outcome) outcome = fin;
    }
    if (outcome && !outcome.told) { outcome.told = true; finished(outcome); }
    if (phase === 'restarting' && next.reachable !== false && (sawDown || Date.now() - since > 90000)) {   // back after the restart
      phase = 'idle';
      if (!next.pending_activation && !next.job?.active) {   // otherwise the update job reports when it's done
        toast('Your Tiiny restarted and the update is active', 'ok');
        notify('Your Tiiny restarted and the update is active');
        refreshHealth(); refreshOverview(); refreshModels();
      }
    }
    if (phase !== 'idle' && Date.now() - since > (phase === 'restarting' ? 10 : 2) * 60000) phase = 'idle';   // nothing happened: show what the device says
    render();
  }
  function finished(job) {
    const ok = job.state === 'SUCCEEDED' || job.state === 'SUCCESS';
    const needsRestart = ok && st?.pending_activation;   // installed, but one restart activates it
    const title = needsRestart ? 'The update is installed. Restart your Tiiny to finish it.'
      : ok ? `Your Tiiny is updated to ${st?.current || job.target_version}` : job.text;
    toast(title, needsRestart ? 'info' : ok ? 'ok' : job.state === 'FAILED' ? 'err' : 'info', {detail: job.error || undefined});
    notify(title, ok && !needsRestart ? 'The update has finished.' : job.error || '');
    if (ok && !needsRestart) { refreshHealth(); refreshOverview(); refreshModels(); }
  }

  function render() {
    clear(body);
    if (lostSince || phase === 'restarting') {
      const waiting = running(up) && up.step === 'download';   // during the download it's a dropped connection, not a restart
      body.append(h('div', {class: 'stack-sm', 'aria-live': 'polite'}, h('strong', {}, waiting ? 'Waiting for your Tiiny to answer' : 'Your Tiiny is restarting'),
        progressBar(0, {indeterminate: true}),
        h('p', {class: 'small muted'}, 'This page reconnects by itself. Keep your Tiiny powered on and connected.'),
        lostSince && Date.now() - lostSince > 10 * 60000 ? h('p', {class: 'small'}, 'This is taking longer than usual. Check that your Tiiny is on and connected to your network.') : null,
        waiting ? null : loginHint()));
      return;
    }
    if (!st) { body.append(loadingBlock('Checking your Tiiny’s version…')); return; }
    if (st.reachable === false) { body.append(errorBlock(st.error || 'No answer from your Tiiny.', {title: 'Couldn’t reach your Tiiny', retry: () => load().catch(() => {})})); return; }
    if (st.service === 'none') {
      body.append(h('p', {class: 'muted small'}, 'Checks for a new TiinyOS version and installs it with the tiiny CLI. Keep the device powered during the upgrade; it restarts at the end.'),
        h('div', {}, viaCli()));
      return;
    }
    const checked = st.fetched_at ? fmtAgo(String(st.fetched_at).replace(/(\.\d{3})\d+/, '$1')) : '—';
    body.append(kvList([['Installed', st.current || '—'], ['Last checked', checked !== '—' ? checked : null]]));
    if (outcome && !((outcome.state === 'SUCCEEDED' || outcome.state === 'SUCCESS') && st.pending_activation)) {   // a restart still has to finish it
      const ok = outcome.state === 'SUCCEEDED' || outcome.state === 'SUCCESS', failed = outcome.state === 'FAILED';
      body.append(h('div', {class: `banner ${ok ? 'ok' : failed ? 'err' : 'info'}`}, icon(ok ? 'check' : failed ? 'alert' : 'info'),
        h('div', {class: 'text'}, h('strong', {}, ok ? `Updated to ${st.current || outcome.target_version}` : outcome.text),
          outcome.error ? h('span', {class: 'small'}, outcome.error) : null)));
    }
    const job = st.job;
    if (running(up) || job || phase === 'starting') {
      const pct = job && job.known && job.percent != null ? job.percent : null;
      const detail = job ? [job.detail, job.speed_bps ? `${fmtBytes(job.speed_bps)}/s` : ''].filter(Boolean).join(' · ') : '';
      const step = running(up) ? (up.step === 'install' ? 'Step 2 of 2 · Install' : 'Step 1 of 2 · Download') : '';
      const downloading = running(up) ? up.step !== 'install' : job ? ['preparing', 'resolving', 'downloading', 'verifying_resources', 'waiting_network'].includes(job.phase) : true;
      const canStop = job ? job.can_cancel : running(up) && downloading;
      body.append(h('div', {class: 'stack-sm fw-job', 'aria-live': 'polite'},
        step ? h('span', {class: 'small faint'}, step) : null,
        h('div', {class: 'row', style: {justifyContent: 'space-between', gap: '10px'}}, h('strong', {}, job ? job.text : running(up) ? up.message || 'Starting…' : 'Starting the update…'),
          pct != null ? h('span', {class: 'small faint'}, `${Math.round(pct)}%`) : null),
        progressBar(pct ?? 0, {indeterminate: pct == null}),
        detail ? h('p', {class: 'small muted ellipsis', title: detail}, detail) : null,
        st.needs_restart ? h('div', {class: 'banner warn'}, icon('alert'), h('div', {class: 'text'}, h('strong', {}, 'Restart your Tiiny to finish the update'),
          h('span', {class: 'small'}, 'The update is installed. One restart activates it; your Tiiny won’t restart by itself.')),
          st.can_reboot ? btn('Restart now', restartToFinish, {small: true, kind: 'primary', icon: 'rotate'}) : null)
          : h('p', {class: 'small muted'}, `Updating to ${target || (job && job.target_version) || st.latest}. ` + (downloading
            ? 'Keep your Tiiny on, and keep this panel running until the download has finished. You can leave this page.'
            : st.restart_requested ? 'Your Tiiny restarts in a moment. Keep it powered on and connected.'
            : 'Keep your Tiiny powered on and connected. It finishes the update by itself; you can leave this page.')),
        job?.restart_hint && !st.needs_restart ? loginHint() : null,
        canStop ? h('div', {}, btn('Stop the update', stopUpdate, {small: true, kind: 'ghost', icon: 'x'})) : null));
      return;
    }
    if (!outcome && up?.status === 'failed') {   // it failed while nobody was watching
      body.append(h('div', {class: 'banner err'}, icon('alert'), h('div', {class: 'text'}, h('strong', {}, 'The last update attempt failed'),
        up.error ? h('span', {class: 'small'}, up.error) : null)));
    }
    if (st.pending_activation) {
      body.append(h('div', {class: 'banner warn'}, icon('alert'), h('div', {class: 'text'}, h('strong', {}, 'Restart your Tiiny to finish the update'),
        h('span', {class: 'small'}, 'The update is installed; one restart activates it.')),
        st.can_reboot ? btn('Restart now', restartToFinish, {small: true, kind: 'primary', icon: 'rotate'}) : null));
    }
    if (st.latest) {
      const rel = st.release || {};
      body.append(h('div', {class: 'stack-sm'},
        h('div', {class: 'row wrap gap-sm', style: {alignItems: 'center'}}, h('strong', {}, `Update ${st.latest} is available`), rel.required ? badge('Required', 'warn') : null),
        rel.subtitle ? h('span', {class: 'small muted'}, rel.subtitle) : null,
        rel.notes ? h('div', {class: 'md fw-notes', html: renderMarkdown(rel.notes)}) : null,
        st.blocked ? h('div', {class: 'banner warn small'}, icon('alert'), h('div', {class: 'text'}, st.blocked)) : null,
        h('div', {class: 'row wrap'}, btn(`Install ${st.latest}`, install, {kind: 'primary', icon: 'download', disabled: !st.can_install}),
          btn('Check again', check, {kind: 'ghost', icon: 'refresh'}))));
    } else if (!st.pending_activation) {
      body.append(h('div', {class: 'row wrap', style: {alignItems: 'center'}}, badge('Up to date', 'ok', 'check'), h('span', {class: 'spacer'}),
        btn('Check for updates', check, {small: true, kind: 'ghost', icon: 'refresh'})));
    }
  }

  async function check() {
    outcome = null;
    apply(await api('/api/firmware/check', {method: 'POST', body: {}}));
    if (st && !st.latest && !st.job) toast('Your Tiiny is up to date', 'ok', {timeout: 2500});
  }
  async function install() {
    const v = st.latest;
    const ok = await confirmDialog({title: `Install update ${v}?`, confirmLabel: `Install ${v}`, message: h('div', {class: 'stack-sm'},
      h('p', {}, 'Your Tiiny downloads the update, installs it and restarts. Running tasks stop and loaded models are unloaded.'),
      h('p', {}, h('strong', {}, 'Keep it powered on and connected until the update has finished.')),
      h('p', {class: 'muted small'}, 'This can take a while. You can leave this page; keep this panel running until the download has finished.'))});
    if (!ok) return;
    outcome = null;
    phase = 'starting';
    since = Date.now();
    target = v;
    render();
    try { apply(await api('/api/firmware/install', {method: 'POST', body: {version: v}})); }
    catch (e) { phase = 'idle'; render(); throw e; }   // the button shows the error
    toast(`Updating your Tiiny to ${v}…`, 'ok', {detail: 'Follow the progress under System → Firmware.'});
  }
  async function stopUpdate() {
    const ok = await confirmDialog({title: 'Stop the update?', confirmLabel: 'Stop the update', danger: true,
      message: `Your Tiiny stops downloading and stays on ${st.current}. You can install the update later.`});
    if (!ok) return;
    apply(await api('/api/firmware/cancel', {method: 'POST', body: {}}));
  }
  async function restartToFinish() {
    const ok = await confirmDialog({title: 'Restart your Tiiny now?', confirmLabel: 'Restart',
      message: 'This activates the update. Running tasks stop and loaded models are unloaded. The device is back in about a minute.'});
    if (!ok) return;
    await api('/api/firmware/reboot', {method: 'POST', body: {}});
    phase = 'restarting';
    since = Date.now();
    sawDown = false;
    render();
  }

  ctx.every(2500, () => { if (phase !== 'idle' || upId || watchId || lostSince || running(up) || st?.job?.active) load().catch(() => {}); });
  load().catch(e => { if (ctx.alive()) clear(body).append(errorBlock(e.message, {title: 'Couldn’t check for updates', retry: () => load().catch(() => {})})); });
  return card({title: 'Firmware', ic: 'shield'}, body);
}

/* The panel itself (tiinyui/selfupdate.py): its version, and updating it from GitHub. It only asks GitHub when you press
   Check for updates, or once a day if you switch that on. */
function panelUpdateCard(ctx) {
  const body = h('div', {class: 'stack'}, loadingBlock('Checking the panel’s version…'));
  let st = null, following = '', restarting = false;

  async function load() {
    st = await api('/api/update');
    if (S.health) S.health.update = {latest: st.latest, newer: st.newer, checked_at: st.checked_at};
    buildNav();
    render();
    if (st.job?.status === 'running' && following !== st.job.id) follow(st.job.id);
  }
  function follow(id) {
    following = id;
    followJob(id, j => { if (st && ctx.alive()) { st.job = j; render(); } }).then(j => {
      following = '';
      if (!j) return;
      if (j.status === 'done') {
        toast(`Version ${j.result?.version || ''} is ready`, 'ok', {detail: 'Restart the panel to start using it.'});
        notify('The panel’s update is ready', 'Restart the panel to start using it.');
      } else if (j.status === 'failed') toast('The update didn’t work', 'err', {detail: j.error});
      if (ctx.alive()) load().catch(() => {});
    });
  }

  function render() {
    if (!ctx.alive()) return;
    clear(body);
    if (restarting) {
      body.append(h('div', {class: 'stack-sm', 'aria-live': 'polite'}, h('strong', {}, 'The panel is restarting'), progressBar(0, {indeterminate: true}),
        h('p', {class: 'small muted'}, 'This page reloads by itself in a few seconds.')));
      return;
    }
    if (!st) { body.append(loadingBlock('Checking the panel’s version…')); return; }
    const rel = st.release || {};
    const job = st.job;
    const ready = job?.status === 'done' && job.result?.version && job.result.version !== st.current;   // installed, not restarted yet
    body.append(kvList([['Installed', st.current], ['Latest', st.latest ? `${st.latest}${rel.published ? ` · ${fmtAgo(rel.published)}` : ''}` : null],
      ['Last checked', st.checked_at ? fmtAgo(st.checked_at) : 'not yet'], ['Kept from before', st.previous ? `${st.previous} (in the panel’s .previous folder)` : null]]));
    if (job?.status === 'running') {
      body.append(h('div', {class: 'stack-sm', 'aria-live': 'polite'}, h('strong', {}, job.message || 'Updating…'),
        progressBar(job.progress == null ? 0 : job.progress * 100, {indeterminate: job.progress == null}),
        h('p', {class: 'small muted'}, 'Your chats, projects and settings aren’t touched. You can leave this page.')));
      return;
    }
    if (ready) {
      body.append(h('div', {class: 'banner ok'}, icon('check'), h('div', {class: 'text'}, h('strong', {}, `Version ${job.result.version} is ready`),
        h('span', {class: 'small'}, 'Restart the panel to start using it. This page reloads by itself.')),
        btn('Restart now', restart, {small: true, kind: 'primary', icon: 'rotate'})));
    } else if (job?.status === 'failed') {
      body.append(h('div', {class: 'banner err'}, icon('alert'), h('div', {class: 'text'}, h('strong', {}, 'The last update didn’t work'),
        h('span', {class: 'small'}, job.error || ''))));
    }
    if (st.error) {
      body.append(h('div', {class: 'banner warn'}, icon('alert'), h('div', {class: 'text'}, h('strong', {}, 'Couldn’t check for updates'), h('span', {class: 'small'}, st.error))));
    }
    if (st.newer && !ready) {
      const how = st.how === 'git' ? 'It updates with git (git pull), like you would yourself.' : st.how === 'zip' ? 'It downloads the new version from GitHub and keeps the old one in case you need it.' : '';
      body.append(h('div', {class: 'stack-sm'},
        h('strong', {}, `Version ${st.latest} is available`),
        rel.notes ? h('details', {class: 'raw', open: true}, h('summary', {}, 'What’s new'), h('div', {class: 'md', html: renderMarkdown(rel.notes)})) : null,
        st.how === 'container' ? h('div', {class: 'banner info'}, icon('info'), h('div', {class: 'text'}, h('strong', {}, 'Update the container'),
          h('span', {class: 'small'}, 'This panel runs in Docker, which updates it by pulling the new image. On the server, in the folder with compose.yaml:'),
          h('code', {class: 'block'}, st.how_note), h('span', {class: 'small muted'}, 'Your data stays in its folder. A tool like Watchtower can do this for you.')))
          : st.how === 'manual' ? h('div', {class: 'banner warn'}, icon('info'), h('div', {class: 'text'}, h('strong', {}, 'Update it yourself'), h('span', {class: 'small'}, st.how_note)))
          : h('p', {class: 'small muted'}, `${how} Your chats, projects and settings aren’t touched.`),
        h('div', {class: 'row wrap'}, !['manual', 'container'].includes(st.how) ? btn(`Update to ${st.latest}`, install, {kind: 'primary', icon: 'download'}) : null,
          rel.url ? h('a', {class: 'btn ghost', href: rel.url, target: '_blank', rel: 'noopener noreferrer'}, icon('link'), h('span', {}, 'On GitHub')) : null)));
    } else if (st.checked_at && !st.error && !ready) {
      body.append(h('div', {class: 'row wrap', style: {alignItems: 'center'}}, st.no_releases ? badge('No releases published yet', '', 'info') : badge('Up to date', 'ok', 'check')));
    }
    const daily = !!S.health?.settings?.update_check_daily;
    body.append(h('div', {class: 'row wrap', style: {alignItems: 'center'}}, btn('Check for updates', check, {small: true, kind: 'ghost', icon: 'refresh'})),
      h('label', {class: 'row gap-sm small', style: {alignItems: 'center'}}, switchInput(daily, setDaily, 'Check once a day'),
        h('span', {}, 'Check once a day ', h('span', {class: 'muted'}, '(it only asks GitHub which version is the latest)'))));
  }

  async function check() {
    st = await api('/api/update/check', {method: 'POST', body: {}});
    if (S.health) S.health.update = {latest: st.latest, newer: st.newer, checked_at: st.checked_at};
    buildNav();
    render();
    if (!st.error && !st.newer) toast(st.no_releases ? 'No version of the panel is published yet' : 'The panel is up to date', 'ok', {timeout: 2500});
  }
  async function setDaily(v) {
    try { S.health = await api('/api/settings', {method: 'POST', body: {update_check_daily: v}}); toast(v ? 'The panel checks for updates once a day' : 'Daily update checks are off', 'ok', {timeout: 2500}); }
    catch (e) { toast('Couldn’t save that', 'err', {detail: e.message}); }
    render();
  }
  async function install() {
    const ok = await confirmDialog({title: `Update the panel to ${st.latest}?`, confirmLabel: `Update to ${st.latest}`, message: h('div', {class: 'stack-sm'},
      h('p', {}, st.how === 'git' ? 'The panel gets the new version with git pull.' : 'The panel downloads the new version from GitHub and puts it in place. The old version is kept in the panel’s .previous folder.'),
      h('p', {}, 'Your chats, projects, Gallery and settings stay as they are. Afterwards you restart the panel.'))});
    if (!ok) return;
    const j = await api('/api/update/install', {method: 'POST', body: {}});
    st.job = j;
    render();
    follow(j.id);
  }
  async function restart() {
    const busy = (await api('/api/update').catch(() => ({}))).busy || [];
    const ok = await confirmDialog({title: 'Restart the panel now?', confirmLabel: 'Restart', danger: busy.length > 0, message: h('div', {class: 'stack-sm'},
      busy.length ? h('p', {}, 'This is still running and stops:') : null, busy.length ? h('ul', {}, busy.map(t => h('li', {}, t))) : null,
      h('p', {}, 'Open terminals close, and an answer that’s being written stops. This page reloads by itself in a few seconds.'))});
    if (!ok) return;
    const old = st.current;
    await api('/api/update/restart', {method: 'POST', body: {force: true}});
    restarting = true;
    render();
    let down = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      await sleep(1000);
      try {
        const info = await (await fetch('/__tiiny__', {cache: 'no-store'})).json();
        if (info.app === 'tiiny-ui' && (down || info.version !== old)) break;
      } catch { down = true; }   // between the old server stopping and the new one starting
    }
    location.reload();
  }

  ctx.every(30000, () => { if (!following && !restarting) load().catch(() => {}); });
  load().catch(e => { if (ctx.alive()) clear(body).append(errorBlock(e.message, {title: 'Couldn’t read the panel’s version', retry: () => load().catch(() => {})})); });
  return card({title: 'Tiiny Control Panel', ic: 'download', sub: 'This panel’s version and its updates'}, body);
}

/* A backup of the panel's own data (tiinyui/backup.py): chats, projects, meetings, the Gallery and code reviews, as one
   ZIP. Never with API keys or sign-ins. */
function panelDataCard(ctx) {
  const body = h('div', {class: 'stack'}, loadingBlock());
  const out = h('div', {class: 'stack-sm'});
  const input = h('input', {type: 'file', accept: '.zip,application/zip', hidden: true});
  const withHistory = h('input', {type: 'checkbox'});
  const KINDS = [['chats', 'Chats'], ['projects', 'Projects'], ['meetings', 'Meetings'], ['gallery', 'Gallery'], ['reviews', 'Code reviews'], ['studio', 'Studio']];
  let sum = null, busy = false;

  async function load() {
    sum = await api('/api/backup');
    render();
    if (sum.job && !busy) follow(sum.job);
  }
  function render() {
    if (!ctx.alive() || !sum) return;
    const c = sum.collections || {};
    const rows = KINDS.filter(([k]) => c[k]?.records).map(([k, label]) => [label, `${c[k].records} · ${fmtBytes(c[k].bytes)}`]);
    clear(body).append(
      h('p', {class: 'muted small'}, 'Everything the panel keeps on this computer, as one ZIP file. The device backup doesn’t include it.'),
      rows.length ? kvList(rows.concat([['In total', fmtBytes(sum.bytes)]])) : h('p', {class: 'muted'}, 'Nothing saved yet.'),
      h('label', {class: 'check'}, withHistory, h('span', {}, h('span', {}, 'Include the performance history'),
        h('small', {class: 'muted'}, `The dashboard’s charts of the last 7 days (${fmtBytes(sum.metrics_bytes || 0)}).`))),
      h('div', {class: 'row wrap'}, btn('Download a backup', exportIt, {kind: 'primary', icon: 'download'}),
        btn('Restore from a backup…', () => input.click(), {icon: 'upload'})),
      h('p', {class: 'muted small'}, 'Never in a backup: API keys, and the sign-ins of this browser and your paired phones.'),
      out, input);
  }

  async function exportIt() {
    follow(await api('/api/backup/export', {method: 'POST', body: {metrics: withHistory.checked}}));
  }
  async function follow(j) {
    busy = true;
    const restoring = j.meta?.action === 'restore';
    const msg = h('span', {class: 'small muted'}, j.message || (restoring ? 'Restoring…' : 'Packing your data…'));
    const bar = progressBar(0, {indeterminate: true});
    clear(out).append(h('div', {class: 'stack-sm', 'aria-live': 'polite'}, msg, bar));
    const fin = await followJob(j.id, x => {
      msg.textContent = x.message || msg.textContent;
      if (x.progress != null) { bar.classList.remove('indeterminate'); bar.firstChild.style.width = `${Math.round(x.progress * 100)}%`; }
    });
    busy = false;
    if (!ctx.alive()) return;
    clear(out);
    if (!fin) return;
    if (fin.status !== 'done') {
      if (fin.status === 'failed') out.append(errorBlock(fin.error || 'It stopped.', {title: restoring ? 'The restore didn’t work' : 'The backup didn’t work'}));
      return;
    }
    if (!restoring && fin.result?.file) {
      const f = fin.result.file;
      out.append(h('div', {class: 'net'}, icon('archive'), h('span', {class: 'spacer ellipsis', title: f.name}, `${f.name} · ${fmtBytes(f.size)}`),
        h('a', {class: 'btn sm primary', href: fileHref(f, true), download: f.name}, icon('download'), 'Download')),
        h('p', {class: 'muted small'}, 'Keep it somewhere safe: it holds your chats and files. The link works for a few hours.'));
      return;
    }
    const r = fin.result || {};
    const parts = [r.added ? `${r.added} added` : '', r.replaced ? `${r.replaced} replaced by a newer copy` : '', r.kept ? `${r.kept} already here` : ''].filter(Boolean);
    out.append(h('div', {class: 'banner ok'}, icon('check'), h('div', {class: 'text'}, h('strong', {}, 'Restored'),
      h('span', {class: 'small'}, [`${parts.join(', ') || 'Nothing new'}.`, r.settings ? 'Settings restored.' : '',
        r.aside ? `What it replaced was set aside in ${r.aside}.` : ''].filter(Boolean).join(' '))),
      btn('Reload the page', () => location.reload(), {small: true, icon: 'refresh'})));
    if (typeof ChatUI !== 'undefined') { ChatUI.cache?.clear?.(); ChatUI.summaries = null; }
    load().catch(() => {});
  }

  input.addEventListener('change', async () => {
    const f = input.files[0];
    input.value = '';
    if (!f) return;
    const msg = h('span', {class: 'small muted'}, `Uploading ${f.name}…`);
    const bar = progressBar(0);
    clear(out).append(h('div', {class: 'stack-sm'}, msg, bar));
    let up, info;
    try {
      up = await uploadFile(f, p => { bar.firstChild.style.width = `${Math.round(p * 100)}%`; });
      msg.textContent = 'Reading the backup…';
      info = await api('/api/backup/inspect', {method: 'POST', body: {file: up.id}});
    } catch (e) { clear(out).append(errorBlock(e.message, {title: 'Couldn’t use that file'})); return; }
    clear(out);
    const choice = await restoreDialog(f.name, info);
    if (choice) follow(await api('/api/backup/restore', {method: 'POST', body: {file: up.id, ...choice}}));
  });

  function restoreDialog(name, info) {
    return new Promise(resolve => {
      let done = false;
      const cols = info.collections || {};
      const lines = KINDS.filter(([k]) => cols[k]?.records).map(([k, label]) => h('li', {}, `${label}: ${cols[k].records}`,
        cols[k].here ? h('span', {class: 'muted'}, ` (${cols[k].here} already here)`) : null));
      const merge = h('input', {type: 'radio', name: 'restore-mode', checked: true});
      const replace = h('input', {type: 'radio', name: 'restore-mode'});
      const settings = h('input', {type: 'checkbox'});   // off: restoring into the same computer shouldn't change its settings
      const go = h('button', {class: 'btn primary', type: 'button', onclick: () => { done = true; m.close(); resolve({mode: replace.checked ? 'replace' : 'merge', settings: settings.checked && !!info.settings}); }}, 'Restore');
      for (const r of [merge, replace]) r.addEventListener('change', () => { go.className = `btn ${replace.checked ? 'danger solid' : 'primary'}`; });
      const m = modal({title: `Restore from ${name}?`, onClose: () => { if (!done) resolve(null); }, body: h('div', {class: 'stack'},
        h('p', {}, `Made ${fmtDate(info.created)}${info.version ? ` with version ${info.version} of the panel` : ''}.`),
        lines.length ? h('ul', {}, lines) : h('p', {class: 'muted'}, 'It has no chats, projects or other items.'),
        info.metrics ? h('p', {class: 'muted small'}, `Also ${info.metrics} day${info.metrics === 1 ? '' : 's'} of performance history (days that aren’t here yet are added).`) : null,
        info.skipped ? h('p', {class: 'muted small'}, `${info.skipped} item${info.skipped === 1 ? ' is' : 's are'} left out: they come from a newer version of the panel.`) : null,
        h('label', {class: 'check'}, merge, h('span', {}, h('span', {}, 'Add what’s missing'),
          h('small', {class: 'muted'}, 'Keeps everything here. When both have the same item, the newer one wins.'))),
        h('label', {class: 'check'}, replace, h('span', {}, h('span', {}, 'Replace everything'),
          h('small', {class: 'muted'}, 'Your current chats, projects, meetings, Gallery and code reviews are set aside first (in the data folder), then the backup takes their place.'))),
        info.settings ? h('label', {class: 'check'}, settings, h('span', {}, h('span', {}, 'Also restore the panel’s settings'),
          h('small', {class: 'muted'}, 'Model pins, idle unloading, agent tools and the like. API keys are never in a backup.'))) : null),
        actions: [h('button', {class: 'btn ghost', type: 'button', onclick: () => m.close()}, 'Cancel'), go]});
    });
  }

  load().catch(e => { if (ctx.alive()) clear(body).append(errorBlock(e.message, {title: 'Couldn’t read the panel’s data', retry: () => load().catch(() => {})})); });
  return card({title: 'Your panel’s data', ic: 'archive', sub: 'Chats, projects, meetings, the Gallery and code reviews'}, body);
}

/* ------------------------------------------------------------------- System */
function viewSystem(root, ctx) {
  const settingsBody = h('div');
  const agentsBody = h('div', {}, loadingBlock());
  const backupOut = h('div', {class: 'stack-sm'});
  const restoreInput = h('input', {type: 'file', accept: '.zip,application/zip', hidden: true});
  restoreInput.addEventListener('change', async () => {
    const f = restoreInput.files[0];
    restoreInput.value = '';
    if (!f) return;
    if (!(await confirmDialog({title: `Restore from ${f.name}?`, danger: true, confirmLabel: 'Restore', message: 'Data on the device is replaced with the contents of this backup. The CLI asks you to confirm in the terminal.'}))) return;
    const t = toast(`Uploading ${f.name}…`, 'info', {timeout: 600000});
    try {
      const up = await uploadFile(f);
      t();
      openTerminal({args: ['restore', {file: up.id}], title: 'Restore from backup'});
    } catch (e) { t(); toast('Upload failed', 'err', {detail: e.message}); }
  });
  const cliCard = S.health && !S.health.cli.found ? cliMissingCard() : card({title: 'Tiiny CLI', ic: 'terminal'}, h('div', {class: 'stack'},
    kvList([['Version', S.health?.cli?.version || '—'], ['Location', S.health?.cli?.path ? h('code', {}, S.health.cli.path) : '—'], ['Config file', S.health?.device?.cli_config ? h('code', {}, S.health.device.cli_config) : null]]),
    h('div', {class: 'row wrap'}, btn('Update the CLI', () => openTerminal({args: ['cli', 'upgrade'], title: 'Update the tiiny CLI', onExit: () => refreshHealth()}), {small: true, icon: 'download'}),
      btn('Shell completion', () => completionHelp(), {small: true, kind: 'ghost', icon: 'terminal'}))));

  root.append(
    h('div', {class: 'grid cols-2'},
      card({title: 'Power', ic: 'power'}, h('div', {class: 'stack'}, h('p', {class: 'muted small'}, 'Restarting or shutting down stops running tasks and unloads all models.'),
        h('div', {class: 'row wrap'}, btn('Restart', restartDevice, {icon: 'rotate'}), btn('Shut down', shutdownDevice, {icon: 'power', kind: 'danger'})))),
      firmwareCard(ctx)),
    h('div', {class: 'grid cols-2'}, S.health?.remote ? null : panelUpdateCard(ctx), cliCard),
    h('div', {class: 'grid cols-2'},
      card({title: 'Device backup', ic: 'archive', sub: 'What’s on your Tiiny'}, h('div', {class: 'stack'},
        h('p', {class: 'muted small'}, 'Save the device’s data (settings, Vault, profile…) as a ZIP file on this computer, or restore one.'),
        h('div', {class: 'row wrap'}, btn('Create backup', async () => {
          clear(backupOut).append(loadingBlock('Creating backup… this can take a while.'));
          const r = await cli(['backup', {outdir: true, prefix: '--output='}], {yes: true, timeout: 3600, label: 'Back up device', silent: true});
          clear(backupOut);
          if (!r.ok) { backupOut.append(errorBlock(cliError(r), {title: 'Backup failed'}), btn('Run in a terminal instead', () => openTerminal({args: ['backup', {outdir: true, prefix: '--output='}], title: 'Back up device'}), {small: true, kind: 'ghost'})); return; }
          if (!r.outputs?.length) { backupOut.append(h('p', {class: 'muted'}, 'The backup finished but no file was produced.'), rawDetails(r.stdout, 'CLI output')); return; }
          append(backupOut, r.outputs.map(f => h('div', {class: 'net'}, icon('archive'), h('span', {class: 'spacer'}, `${f.name} · ${fmtBytes(f.size)}`), h('a', {class: 'btn sm primary', href: fileHref(f, true), download: f.name}, icon('download'), 'Download'))));
        }, {icon: 'archive', kind: 'primary'}), btn('Restore from file…', () => restoreInput.click(), {icon: 'upload'})), backupOut, restoreInput)),
      S.health?.remote ? null : panelDataCard(ctx)),
    h('div', {class: 'grid cols-2'}, typeof appCard === 'function' ? appCard(ctx) : null, typeof devicesCard === 'function' ? devicesCard(ctx) : null),
    card({title: 'Agents', ic: 'spark', sub: 'Apps from the Agent Store installed on the device'}, agentsBody),
    card({title: 'Panel settings', ic: 'settings', sub: 'Normally empty: the panel reads the device address and API key from the tiiny CLI'}, settingsBody),
    agentToolsCard(),
    decisionsCard(ctx),
    card({title: 'About', ic: 'info'}, h('div', {class: 'stack-sm'},
      h('p', {}, `Tiiny Control Panel ${S.health?.version || ''} · Python ${S.health?.python || ''}`),
      h('p', {class: 'muted small'}, onServer() ? 'Runs on the server, and your devices sign in to it (System → Devices). Device requests go straight from the server to your Tiiny; the API key never leaves the server.'
        : 'Runs only on this computer. Device requests go straight from here to your Tiiny; the API key never leaves this machine.'),
      h('p', {}, h('a', {href: DOCS_URL, target: '_blank', rel: 'noopener noreferrer'}, 'Tiiny developer docs ↗')))));

  function renderSettings() {
    const s = S.health?.settings || {};
    if (S.health?.remote) { clear(settingsBody).append(h('p', {class: 'muted'}, 'Panel settings can only be changed on the computer running the panel.')); return; }
    const fields = [
      ['device_address', 'Device address', s.device_address, 'e.g. 192.168.1.50. Leave empty to use the tiiny CLI’s connected device.'],
      ['device_port', 'Device port', s.device_port, 'Default 80.'],
    ];
    const inputs = {};
    const keyInput = h('input', {class: 'input', type: 'password', placeholder: s.api_key_set ? `saved (${s.api_key_hint}); type to replace` : 'Leave empty to use the CLI’s key', autocomplete: 'off'});
    clear(settingsBody).append(h('form', {class: 'form', onsubmit: async e => {
      e.preventDefault();
      const body = {};
      for (const [k] of fields) body[k] = inputs[k].value.trim();
      if (keyInput.value.trim()) body.api_key = keyInput.value.trim();
      try { S.health = await api('/api/settings', {method: 'POST', body}); toast('Settings saved', 'ok'); renderSettings(); refreshOverview(); refreshModels(); }
      catch (err) { toast('Couldn’t save settings', 'err', {detail: err.message}); }
    }},
      h('div', {class: 'form-row'}, fields.map(([k, label, value, hint]) => { inputs[k] = h('input', {class: 'input', value: value || '', placeholder: hint.split('.')[0]}); return h('div', {class: 'field'}, h('label', {}, label), inputs[k], h('small', {class: 'hint'}, hint)); })),
      h('div', {class: 'field'}, h('label', {}, 'API key override'), keyInput, h('small', {class: 'hint'}, 'Stored in ~/.config/tiiny-ui/settings.json (readable only by you).')),
      h('p', {class: 'muted small'}, 'For safety, the tiiny program and its config file can only be chosen when you start the panel: ',
        h('code', {}, 'python3 tiiny_ui.py --tiiny PATH --cli-config FILE'), '.'),
      h('div', {class: 'row wrap'}, btn('Save settings', null, {kind: 'primary', type: 'submit'}),
        s.api_key_set ? btn('Forget saved key', async () => { S.health = await api('/api/settings', {method: 'POST', body: {api_key: ''}}); toast('Saved key removed', 'ok'); renderSettings(); }, {kind: 'ghost'}) : null)));
  }

  async function loadAgents() {
    const r = await dev('/api/services', {service: 'agents', quiet: true, silent: true});
    if (!ctx.alive()) return;
    clear(agentsBody);
    if (!r.ok) { agentsBody.append(h('p', {class: 'muted'}, r.error || 'Not available.')); return; }
    const list = Array.isArray(r.json) ? r.json : findArray(r.json) || [];
    if (!list.length) { agentsBody.append(emptyState('spark', 'No agents installed', 'Install agents from the Agent Store in TiinyOS.')); return; }
    agentsBody.append(h('div', {class: 'grid cols-3'}, list.map(a => h('div', {class: 'conn-card'},
      h('div', {class: 'conn-head'}, h('span', {class: 'icon-box'}, icon('spark')), h('div', {class: 'spacer', style: {minWidth: 0}}, h('strong', {}, pick(a, 'name', 'display_name', 'id')),
        h('span', {class: 'small muted ellipsis', style: {display: 'block'}}, (pick(a, 'description') && pick(a, 'description') !== pick(a, 'name')) ? pick(a, 'description') : pick(a, 'id'))),
        pick(a, 'status', 'state') ? badge(String(pick(a, 'status', 'state'))) : null)))));
  }

  (S.health ? Promise.resolve() : refreshHealth()).then(() => { if (ctx.alive()) renderSettings(); });
  loadAgents();
  if (ctx.query.get('section') === 'agent-tools') setTimeout(() => $('#agent-tools-card')?.scrollIntoView?.({block: 'start', behavior: 'smooth'}), 60);
}

/* System → Decision models: which model the panel's features ask, and a pill for each feature (tiinyui/decide.py). */
function decisionsCard(ctx) {
  const body = h('div', {class: 'stack'});
  const hint = savedHint();
  const saveOff = listSaver('decisions_off', hint);
  const render = () => {
    const s = S.health?.settings || {};
    const remote = !!S.health?.remote;
    const list = modelsOf('decide');
    const off = new Set(s.decisions_off || []);
    const sel = h('select', {class: 'input sm', 'aria-label': 'Decision model', disabled: remote},
      h('option', {value: ''}, 'Automatic: a loaded one, else the smallest'),
      list.map(m => h('option', {value: m.id, selected: m.id === s.decision_model},
        `${S.running.has(m.id) ? '● ' : ''}${m.display_name || m.name}${num(m.npu_usage) ? ` · ${m.npu_usage}% of the NPU` : ''}`)));
    sel.addEventListener('change', async () => {
      try { S.health = await api('/api/settings', {method: 'POST', body: {decision_model: sel.value}}); hint.flash(); }
      catch (e) { toast('Couldn’t save that', 'err', {detail: e.message}); render(); }
    });
    const rows = [['chat', 'Chat and agent'], ['pages', 'Other pages']].map(([g, label]) => ({label,
      items: DECISION_FEATURES.filter(f => f[2] === g).map(([key, what, , short]) => ({key, label: short, title: what, on: !off.has(key), disabled: remote}))}));
    append(clear(body), [
      list.length ? h('div', {class: 'dm-model'}, h('span', {class: 'trow-label'}, 'Model'), sel,
        h('span', {class: 'small muted'}, 'Loads when a feature needs it, if it fits next to the loaded models. It never unloads anything to make room.'))
        : h('div', {class: 'banner info'}, icon('info'), h('div', {class: 'text'}, h('strong', {}, 'No decision model on your Tiiny yet'),
          h('span', {class: 'small'}, 'Get one from the model store, for example KnowLine-4B (17% of the NPU) or d3-lite (7%). Without one, everything works as before.')),
          btn('Open the store', () => { sessionStorage.setItem('tiiny.modelsTab', 'store'); go('models'); }, {small: true})),
      toggleRows(rows, (k, on) => { if (on) off.delete(k); else off.add(k); return saveOff(off); }),
      remote ? h('p', {class: 'muted small'}, 'You can change these on the computer running the panel.')
        : list.length ? h('div', {}, btn('Try one in the Playground', () => tryDecisionModel(s.decision_model || list[0].id), {small: true, kind: 'ghost', icon: 'spark'})) : null]);
  };
  render();
  ctx.on('models', render);
  ctx.on('running', render);
  const c = card({title: 'Decision models', icon: 'spark', sub: 'Quick yes/no decisions for the agent, chat, Vault, code review, Gallery, projects and meetings', actions: [hint.el]}, body);
  c.id = 'decisions-card';
  return c;
}

/* On/off choices as compact rows: one row per group, each choice a pill (✓ on, + off) that saves when clicked.
   rows: [{label, note, items: [{key, label, title, on, disabled}]}]; save(key, on) returns a promise. */
function toggleRows(rows, save) {
  const paint = (b, on) => { b.setAttribute('aria-pressed', String(on)); b.firstChild.replaceWith(icon(on ? 'check' : 'plus')); };
  return h('div', {class: 'trows'}, rows.filter(r => r.items.length).map(r => h('div', {class: 'trow'},
    h('div', {class: 'trow-label'}, r.label),
    h('div', {class: 'trow-pills'}, r.items.map(it => {
      const b = h('button', {type: 'button', class: 'tpill', 'aria-pressed': String(!!it.on), title: it.title || it.label, disabled: !!it.disabled},
        icon(it.on ? 'check' : 'plus'), h('span', {}, it.label));
      b.addEventListener('click', async () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        paint(b, on);   // straight away; put back if saving fails
        try { await save(it.key, on); } catch (e) { paint(b, !on); toast('Couldn’t save that', 'err', {detail: e.message}); }
      });
      return b;
    }), r.note ? h('span', {class: 'trow-note'}, r.note) : null))));
}
/* A quiet "Saved" in a card's header, instead of a toast for every click. */
function savedHint() {
  const el = h('span', {class: 'saved-hint', 'aria-live': 'polite'});
  let t = null;
  return {el, flash() { el.replaceChildren(icon('check'), 'Saved'); el.classList.add('show'); clearTimeout(t); t = setTimeout(() => el.classList.remove('show'), 1600); }};
}
/* Settings lists that several quick clicks change one after another (the last save carries all of them). */
function listSaver(key, hint) {
  let chain = Promise.resolve();
  return next => (chain = chain.catch(() => {}).then(async () => {
    S.health = await api('/api/settings', {method: 'POST', body: {[key]: [...next]}});
    hint.flash();
  }));
}
/* A section that folds away: a one-line summary with its current value, the details inside. */
function fold(title, value, ...body) {
  return h('details', {class: 'fold'}, h('summary', {}, icon('chevron', 'chev'), h('span', {}, title), value ? h('span', {class: 'fold-value'}, value) : null),
    h('div', {class: 'fold-body'}, body));
}

/* System → Agent tools: which tools agent mode may use, the web search engine, and whether it may use this computer. */
const TOOL_SHORT = {history: 'Past chats, meetings, Gallery', save_web_page_to_vault: 'Save web pages', search_vault: 'Search the Vault',
  save_note_to_vault: 'Save notes', project_files: 'Project files', device_status: 'Device status', list_models: 'List models'};
const GROUP_SHORT = {files: 'Your files', make: 'Images', helpers: 'Helpers'};
function agentToolsCard() {
  const body = h('div', {class: 'stack'});
  const hint = savedHint();
  const saveOff = listSaver('agent_tools_off', hint);
  const render = () => {
    const s = S.health?.settings || {};
    const pc = S.health?.commands || {};
    const remote = !!S.health?.remote;
    let engine = s.search_engine || 'duckduckgo';
    const key = h('input', {class: 'input', type: 'password', autocomplete: 'off', 'aria-label': 'Brave Search API key',
      placeholder: s.search_brave_key_set ? `saved (${s.search_brave_key_hint}); type to replace` : 'Your Brave Search API key'});
    const url = h('input', {class: 'input', value: s.search_searxng_url || '', placeholder: 'http://192.168.1.20:8080', 'aria-label': 'SearXNG address'});
    const extra = h('div', {class: 'stack-sm'});
    const out = h('div', {class: 'stack-sm'});
    const showExtra = () => {
      clear(extra);
      if (engine === 'duckduckgo') extra.append(h('p', {class: 'muted small'}, 'No account needed. DuckDuckGo sometimes pauses automated searches for a few minutes; if that happens a lot, use Brave Search or SearXNG.'));
      if (engine === 'brave') extra.append(h('div', {class: 'field'}, h('label', {}, 'Brave Search API key'), key,
        h('small', {class: 'hint'}, 'Get one at ', h('a', {href: 'https://api-dashboard.search.brave.com/', target: '_blank', rel: 'noopener noreferrer'}, 'api-dashboard.search.brave.com'),
          '. It’s kept in ~/.config/tiiny-ui/settings.json (readable only by you) and never shown in the page.')));
      if (engine === 'searxng') extra.append(h('div', {class: 'field'}, h('label', {}, 'SearXNG address'), url,
        h('small', {class: 'hint'}, 'Your own SearXNG server. Its JSON output must be on: add json under search: formats: in its settings.yml.')));
    };
    const saveAndTest = async () => {
      const b = {search_engine: engine};
      if (engine === 'searxng') b.search_searxng_url = url.value.trim();
      if (engine === 'brave' && key.value.trim()) b.search_brave_key = key.value.trim();
      clear(out).append(loadingBlock('Saving and searching for “Tiiny AI”…'));
      try { S.health = await api('/api/settings', {method: 'POST', body: b}); }
      catch (e) { clear(out).append(errorBlock(e.message, {title: 'Couldn’t save'})); return; }
      try {
        const r = await api('/api/web/search', {method: 'POST', body: {query: 'Tiiny AI', count: 3}});
        clear(out).append(h('div', {class: 'banner ok'}, icon('check'), h('div', {class: 'text small'}, h('strong', {}, `${r.engine} works`),
          h('ol', {class: 'step-links'}, r.results.map(x => h('li', {}, safeUrl(x.url) ? h('a', {href: safeUrl(x.url), target: '_blank', rel: 'noopener noreferrer'}, x.title) : x.title))))));
      } catch (e) { clear(out).append(errorBlock(e.message, {title: 'Saved, but the test search failed'})); }
    };
    const fileVerbs = onServer() ? 'find, read and write' : 'find, open, read and write';
    const commandsInfo = remote ? [h('p', {class: 'muted small'}, onServer() ? 'Only on a device with full access.' : 'Only on the computer running the panel, never from a phone.')]
      : pc.enabled ? [h('p', {class: 'small'}, `Agent mode can run commands as ${pc.user} (${pc.shell}) and ${fileVerbs} files on ${hereName()}${S.health?.container ? ' (inside its container: only the folders you mounted)' : ''}. `,
          'It asks before every command, every file change and everything it opens, even in chats set to never ask.'),
        h('p', {class: 'muted small'}, 'To turn it off, start the panel without --allow-commands. To keep only some of these, use the pills above.')]
      : [h('p', {class: 'muted small'}, `Agent mode can also run commands and ${fileVerbs} files on ${hereName()}. To allow that, start the panel with:`),
        h('code', {class: 'block'}, 'python3 tiiny_ui.py --allow-commands'),
        h('p', {class: 'muted small'}, 'It then asks before every command, file change and file it opens. To keep it on when you start from the app menu, add the panel to the app menu again after starting it this way.')];
    // One pill per tool (tools that only work together share one). Off means the model is never offered it.
    const off = new Set(s.agent_tools_off || []);
    const seen = new Set();
    const toggles = AgentTools.filter(t => { const k = toolKey(t); if (seen.has(k)) return false; seen.add(k); return true; });
    const rows = TOOL_GROUPS.map(([g, gname]) => {
      const locked = remote || (g === 'computer' && !pc.enabled);
      const noScreen = t => onServer() && toolKey(t) === 'open_on_computer';   // a server has no screen to open things on
      return {label: GROUP_SHORT[g] || gname, note: g === 'computer' && !pc.enabled && !remote ? 'Needs --allow-commands (see below)' : '',
        items: toggles.filter(t => t.group === g).sort((x, y) => toolRank(x) - toolRank(y)).map(t => ({key: toolKey(t), label: TOOL_SHORT[toolKey(t)] || t.title,
          title: `${t.title}: ${t.risk === 'read' ? 'it only looks, so it runs without asking' : t.alwaysAsk ? 'asks every time' : 'asks before it runs'}`,
          on: !off.has(toolKey(t)) && !noScreen(t), disabled: locked || noScreen(t)}))};
    });
    clear(body).append(
      h('p', {class: 'muted small'}, remote ? 'You can change these on the computer running the panel.'
        : 'Tools that are off are never offered to the model, in any chat. Anything that changes something still asks first.'),
      toggleRows(rows, (k, on) => { if (on) off.delete(k); else off.add(k); return saveOff(off); }),
      h('div', {},
        fold('Web search', engineName(),
          h('p', {class: 'muted small'}, 'Lets the agent find real pages instead of guessing addresses. It asks before searching, and only the search words go to the search engine.'),
          ...(remote ? [h('p', {class: 'muted small'}, 'You can change it on the computer running the panel.')] : [
            segmented([['duckduckgo', 'DuckDuckGo'], ['brave', 'Brave Search'], ['searxng', 'SearXNG']], engine, v => { engine = v; showExtra(); clear(out); }),
            extra,
            h('div', {class: 'row wrap'}, btn('Save and test', saveAndTest, {small: true, kind: 'primary', icon: 'search'}),
              s.search_brave_key_set ? btn('Forget the Brave key', async () => { S.health = await api('/api/settings', {method: 'POST', body: {search_brave_key: ''}}); toast('Brave key removed', 'ok'); render(); }, {small: true, kind: 'ghost'}) : null),
            out,
            h('p', {class: 'faint small'}, 'Why not Google? Google’s search API is closed to new users and shuts down in January 2027, and Google doesn’t allow programs to read its result pages. A SearXNG server can include Google’s results.')])),
        fold(`Commands on ${hereName()}`, remote ? (onServer() ? 'Not from this device' : 'Not from a phone') : pc.enabled ? 'On' : 'Off', ...commandsInfo)));
    showExtra();
  };
  render();
  const c = card({title: 'Agent tools', icon: 'spark', sub: 'What agent mode in a chat may use', actions: [hint.el]}, body);
  c.id = 'agent-tools-card';
  return c;
}

function completionHelp() {
  const shells = [['bash', 'source <(tiiny completion bash)', 'echo \'source <(tiiny completion bash)\' >> ~/.bashrc'], ['zsh', 'source <(tiiny completion zsh)', 'echo \'source <(tiiny completion zsh)\' >> ~/.zshrc'],
    ['fish', 'tiiny completion fish | source', 'tiiny completion fish > ~/.config/fish/completions/tiiny.fish']];
  modal({title: 'Tab completion for tiiny', size: 'wide', body: h('div', {class: 'stack'}, h('p', {class: 'muted'}, 'Press Tab to complete commands and flags in your own terminal.'),
    shells.map(([sh, now, always]) => h('div', {class: 'stack-sm'}, h('strong', {}, sh), h('div', {class: 'code-block'}, iconBtn('copy', 'Copy', () => copyText(always, 'Command copied')), `# this session\n${now}\n# every new session\n${always}`))))});
}

/* =========================================================================
   Theme, drag and drop, keyboard, start-up
   ========================================================================= */
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const b = $('#theme-btn');
  clear(b).append(icon(t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'monitor'));
  b.title = `Theme: ${t === 'light' ? 'light' : t === 'dark' ? 'dark' : 'follow system'} (click to change)`;
}
function setupTheme() {
  let t = 'system';
  try { t = localStorage.getItem('tiiny.theme') || 'system'; } catch { /* ignore */ }
  applyTheme(t);
  $('#theme-btn').addEventListener('click', () => {
    t = t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system';
    try { localStorage.setItem('tiiny.theme', t); } catch { /* ignore */ }
    applyTheme(t);
  });
}

function setupDragDrop() {
  const overlay = $('#drop-overlay');
  let depth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  const labels = () => {
    if (S.view === 'chat') return ['Drop to attach', 'Images and text files go into your message'];
    if (S.view === 'vault') return ['Drop to add to your Vault', 'Files are uploaded and indexed'];
    if (S.view === 'projects' && S.dropHandler) return ['Drop to add to this project', 'Every chat in the project can use them'];
    if (S.view === 'playground' && S.dropHandler) return ['Drop to use this file', ''];
    return ['Drop to add to your Vault', 'Your Tiiny indexes them for search and chat'];
  };
  window.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    const [t, s] = labels();
    $('#drop-title').textContent = t;
    $('#drop-sub').textContent = s;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    if (S.dropHandler) S.dropHandler(files);
    else { VaultUploader.enqueue(files); toast(`Adding ${files.length} file(s) to your Vault`, 'info', {action: {label: 'Open Vault', fn: () => go('vault')}}); }
  });
}

/* Shown when this browser hasn't been signed in by the panel (or its sign-in was reset). */
function showSignedOut(state = 'signed-out') {
  const app = $('#app');
  if (app.classList.contains('signed-out')) return;
  app.classList.add('signed-out');
  if (viewCleanup) { try { viewCleanup(); } catch (e) { console.error(e); } viewCleanup = null; }
  clear($('#modal-root'));
  $('#view-title').textContent = state === 'no-server' ? 'Can’t reach the panel' : 'Sign in';
  $('#view-sub').textContent = '';
  const view = clear($('#view'));
  if (state === 'no-server') {
    view.append(h('div', {class: 'signin-box'}, errorBlock('The Tiiny Control Panel isn’t answering. Start it again from your app menu, or with python3 tiiny_ui.py.',
      {title: 'Lost contact with the panel', retry: () => location.reload()})));
    return;
  }
  view.append(h('div', {class: 'signin-box'}, card({title: 'This browser isn’t signed in', icon: 'shield'},
    h('p', {}, 'Other programs and user accounts on this computer can reach the panel too, so it only works in a browser it has signed in.'),
    h('p', {}, 'To sign in, open ', h('strong', {}, 'Tiiny Control Panel'), ' from your app menu, or run this in the panel’s folder:'),
    h('code', {class: 'block'}, 'python3 tiiny_ui.py'),
    h('p', {class: 'muted small'}, 'Either one opens the panel signed in, whether or not it’s already running. This page then updates by itself. ',
      `Bookmarks work once you’re signed in, as long as they use the same address: ${location.host}.`))));
  window.addEventListener('storage', e => { if (e.key === SIGNIN_KEY && e.newValue) location.reload(); });
}

async function init() {
  for (const slot of document.querySelectorAll('[data-icon]')) slot.replaceWith(icon(slot.dataset.icon));
  $('#drop-overlay .drop-icon').replaceWith(icon('upload'));
  clear($('#activity-close')).append(icon('x'));
  buildNav();
  setupTheme();
  setupDragDrop();
  $('#activity-btn').addEventListener('click', () => toggleActivity());
  $('#activity-close').addEventListener('click', () => toggleActivity(false));
  $('#activity-clear').addEventListener('click', () => { Activity.items = []; Activity.errors = 0; renderActivity(); renderActivityBadge(); });
  $('#terms-btn').addEventListener('click', e => { e.stopPropagation(); termsMenu(); });
  $('#device-pill').addEventListener('click', () => go('dashboard'));
  setupNavDrawer();
  bus.addEventListener('running', updatePill);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenu(); if (Activity.open && !$('#modal-root').children.length) toggleActivity(false); } });
  window.addEventListener('beforeunload', e => { if ([...Terms.values()].some(t => t.running) || VaultUploader.busy) { e.preventDefault(); e.returnValue = ''; } });

  if (TOKEN.includes('{{')) {
    $('#view').append(errorBlock('Start the panel with python3 tiiny_ui.py and use the page it opens, not this file.', {title: 'Opened as a file'}));
    return;
  }
  if (!TOKEN) {
    const st = await getSessionToken();
    if (st !== 'ok') { showSignedOut(st); return; }
  }
  await refreshHealth();
  buildNav();   // phones: leave out the pages that only work on the computer; System: a dot when an update is out
  window.addEventListener('hashchange', route);   // only now: a page drawn before the session token arrives gets refused
  route();
  refreshOverview().then(() => { if (S.state === 'online' && !S.modelsAt) refreshModels(); });
  setInterval(() => { if (!document.hidden && S.view !== 'dashboard') refreshOverview(); }, 20000);
}
