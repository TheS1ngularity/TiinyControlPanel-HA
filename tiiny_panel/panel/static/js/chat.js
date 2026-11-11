/* Chat: streaming conversations, projects, files pinned to a chat (with citations), and Agent mode.
   Chats are saved on the panel server, so every browser (and a paired phone) sees the same list. */
'use strict';

const ChatUI = {currentId: null, live: new Map(), preset: null, draft: null, draftImages: null, mounted: null, summaries: null, cache: new Map(), scope: 'all', projects: [], migrated: false};
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|xml|html?|log|ini|toml|cfg|conf|py|js|mjs|ts|tsx|jsx|java|kt|c|h|cc|cpp|hpp|cs|go|rs|rb|php|sh|bash|zsh|sql|swift|r|lua|pl|tex|srt|vtt|env|css|scss|vue|svelte)$/i;
const DOC_EXT = /\.(pdf|docx|docm|pptx|xlsx|xlsm|odt|odp|ods|epub)$/i;
/* Message -> open or closed, once you've clicked its thinking box; it then stays that way through re-renders. */
const ThinkOpen = new WeakMap();
const ReadKeys = new WeakMap();   // a key per answer for its 🔊 button (voice.js)
const readKey = m => ReadKeys.get(m) || (ReadKeys.set(m, uid()), ReadKeys.get(m));

/* A streaming reply is rebuilt on every frame. Patch the message on screen instead of replacing it, keeping the
   same thinking box: a new box would start at the top again, so you couldn't scroll down to the newest thoughts.
   The box follows the newest text while it's scrolled to the end, and stays where you put it once you scroll up.
   Returns false when there's no box to keep yet (the caller then just swaps the message). */
function patchLiveMsg(oldNode, newNode) {
  const oldBody = oldNode.lastElementChild, newBody = newNode.lastElementChild;
  const box = n => n && [...n.children].find(c => c.matches('details.think'));
  const oldBox = box(oldBody), newBox = box(newBody);
  if (!oldBox || !newBox) return false;
  const tb = oldBox.querySelector('.think-body');
  const atEnd = tb.scrollHeight - tb.scrollTop - tb.clientHeight < 24;
  const prev = tb.textContent, next = newBox.querySelector('.think-body').textContent;
  if (next !== prev) { if (next.startsWith(prev)) tb.append(next.slice(prev.length)); else tb.textContent = next; }
  oldBox.querySelector('.think-label').textContent = newBox.querySelector('.think-label').textContent;
  if (oldBox.open !== newBox.open) oldBox.open = newBox.open;
  for (const c of [...oldBody.childNodes]) if (c !== oldBox) c.remove();
  const kids = [...newBody.childNodes], i = kids.indexOf(newBox);
  oldBox.before(...kids.slice(0, i));
  oldBox.after(...kids.slice(i + 1));
  if (atEnd && oldBox.open) tb.scrollTop = tb.scrollHeight;
  return true;
}
/* A thinking box that appears while the model thinks starts at its newest line. */
function followThink(node) {
  const tb = node?.querySelector('details.think[open] .think-body');
  if (tb) tb.scrollTop = tb.scrollHeight;
}

function chatPrefs(patch) {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('tiiny.chatPrefs') || '{}'); } catch { /* ignore */ }
  if (patch) { p = {...p, ...patch}; try { localStorage.setItem('tiiny.chatPrefs', JSON.stringify(p)); } catch { /* ignore */ } }
  return p;
}

function newChatRecord({project_id = null, model, agent} = {}) {
  const prefs = chatPrefs();
  const project = project_id ? ChatUI.projects.find(p => p.id === project_id) : null;
  return {id: uid(), title: 'New chat', project_id, model: model || project?.model || prefs.model || 'default', system: '', messages: [],
    thinking: null, depth: null, agent: agent ?? false, agentAllow: {}, agentAuto: false, useVault: false, useProfile: !!prefs.useProfile,
    knowledge_id: null, pinned_count: 0, unsaved: true, created: Date.now() / 1000, updated: Date.now() / 1000};
}

/* ---- persistence ----
   The panel writes replies itself (tiinyui/turns.py) and counts every change to a chat's messages (rev). A save from a
   page with an older copy keeps the panel's messages and takes only the rest (title, model, settings), so a tab that
   missed a reply can't overwrite it; the answer then carries the panel's messages, and the page shows those. */
const saveTimers = new Map();
function saveChat(chat, delay = 500) {
  if (!chat) return;
  delete chat.unsaved;
  chat.updated = Date.now() / 1000;
  ChatUI.cache.set(chat.id, chat);
  if (ChatUI.summaries) {
    const s = ChatUI.summaries.find(x => x.id === chat.id);
    const row = {id: chat.id, title: chat.title, project_id: chat.project_id, updated: chat.updated};
    if (s) Object.assign(s, row); else ChatUI.summaries.unshift(row);
  }
  clearTimeout(saveTimers.get(chat.id));
  saveTimers.set(chat.id, setTimeout(() => writeChat(chat), delay));
}
async function writeChat(chat, {without = null} = {}) {
  clearTimeout(saveTimers.get(chat.id));
  saveTimers.delete(chat.id);
  const rec = without ? {...chat, messages: chat.messages.filter(m => m !== without)} : chat;
  try {
    const out = await Store.put('chats', rec);
    if (typeof out?.rev === 'number') chat.rev = out.rev;
    if (out?.messages_kept && !ChatUI.live.has(chat.id)) takeMessages(chat, out.messages);
    return out;
  } catch (e) { toast('Couldn’t save the chat', 'err', {detail: e.message}); return null; }
}
window.addEventListener('beforeunload', () => {
  for (const [id, t] of saveTimers) {
    clearTimeout(t);
    const chat = ChatUI.cache.get(id);
    if (chat) fetch(`/api/store/chats/${id}`, {method: 'PUT', keepalive: true, body: JSON.stringify(chat), headers: {'Content-Type': 'application/json', 'X-Tiiny-Token': TOKEN}}).catch(() => {});
  }
});
/* The panel's messages win (see above). A reply it's still writing is shown live; one that was cut off says so. */
function takeMessages(chat, messages) {
  chat.messages = Array.isArray(messages) ? messages : [];
  attachTurn(chat).finally(() => { if (ChatUI.mounted?.chatId() === chat.id) ChatUI.mounted.afterFinish(); });
}
async function attachTurn(chat) {
  const last = chat.messages[chat.messages.length - 1];
  let job = null;
  if (last?.pending && !ChatUI.live.has(chat.id)) {
    try { job = (await api(`/api/chats/${encodeURIComponent(chat.id)}/turn`)).job; } catch { job = null; }
  }
  for (const m of chat.messages) if (m.pending && !(job && m === last)) { m.pending = false; if (!m.content && !m.error) m.error = 'Interrupted.'; }
  if (job) followTurn(chat, job.id, last);
  return !!job;
}
async function loadChat(id) {
  const cached = ChatUI.cache.get(id);
  if (cached && (cached.unsaved || ChatUI.live.has(id))) return cached;   // not on the panel yet, or a reply this page follows: its copy is the newest
  if (cached && saveTimers.has(id)) await writeChat(cached);   // your latest change goes out first
  const c = await Store.get('chats', id);
  if (!Array.isArray(c.messages)) c.messages = [];
  ChatUI.cache.set(id, c);
  await attachTurn(c);
  return c;
}

/* Which chats have a reply being written (in any tab, on any device, or by a routine): a dot in the chat list. */
const ChatRunning = {
  map: new Map(),   // chat id → {waiting: an approval waits}
  newest: new Map(),   // chat id → the chat's rev after its latest reply (running or finished in the last minutes)
  mark(id, on) {
    if (on) this.map.set(id, this.map.get(id) || {waiting: false}); else this.map.delete(id);
    ChatUI.mounted?.renderList();
  },
  async refresh() {
    try {
      const r = await api('/api/turns');
      this.map = new Map((r.turns || []).map(t => [t.chat, {waiting: !!t.waiting}]));
      this.newest = new Map();
      for (const t of [...(r.recent || []), ...(r.turns || [])]) this.newest.set(t.chat, Math.max(this.newest.get(t.chat) || 0, t.rev || 0));
    } catch { return; }   // the panel is busy or restarting: keep what we had
    ChatUI.mounted?.renderList();
  },
  /* A reply this page didn't follow was written (or is being written) in this chat since it was loaded. */
  changed(chat) { return !!chat && !ChatUI.live.has(chat.id) && (this.map.has(chat.id) || (this.newest.get(chat.id) || 0) > (chat.rev || 0)); },
};

function chatModels() {
  const chat = modelsOf('chat');
  return {loaded: chat.filter(m => S.running.has(m.id)), other: chat.filter(m => !S.running.has(m.id))};
}

function thinkingOptions(chat) {
  const m = S.modelsById.get(chat.model);
  const t = m?.thinking;
  if (!t || !t.supported) return null;
  const levels = t.levels || [];
  const auto = !!t.toggleable && chat.thinking === 'auto' && decisionOn('chat_thinking');   // a decision model decides per message
  const enabled = t.toggleable ? (auto ? (t.enabled_by_default ?? true) : (typeof chat.thinking === 'boolean' ? chat.thinking : (t.enabled_by_default ?? true))) : true;
  const level = levels.length ? (levels.includes(chat.depth) ? chat.depth : (t.default_level || levels[0])) : null;
  return {toggleable: !!t.toggleable, enabled, levels, level, auto};
}

function chatMarkdown(c) {
  return [`# ${c.title}`, ''].concat(c.messages.map(m => m.role === 'user'
    ? `**You:** ${m.content || ''}${m.docs?.length ? `\n\n_Attached: ${m.docs.map(d => d.name).join(', ')}_` : ''}`
    : `**${shortName(m.meta?.model || 'Tiiny')}:** ${splitThinking(m).answer || m.error || ''}`)).join('\n\n');
}

/* A step waiting for your OK anywhere (a routine, a reply started on another device) shows as a desktop notification
   while the panel is in the background, once per step. Replies this page follows say so themselves (followTurn). */
const TurnAlerts = {seen: new Set()};
setInterval(async () => {
  if (!document.hidden) return;   // notifications only show while the panel isn't in front
  let r;
  try { r = await api('/api/turns'); } catch { return; }
  for (const t of r.turns || []) {
    for (const i of t.waiting_steps || []) {
      const key = `${t.id}:${i}`;
      if (TurnAlerts.seen.has(key)) continue;
      TurnAlerts.seen.add(key);
      notify('Your Tiiny is waiting for your OK', t.title || 'A reply needs your OK');
    }
  }
}, 20000);

/* ---- replies: the panel writes them (tiinyui/turns.py); the page shows them as they're written ----
   ChatUI.live has the replies this page follows: chat id → {jid, msg, n (the last event seen)}. A reply carries on when
   the page closes or the phone sleeps, and opening the chat again picks it up where it is (attachTurn). */
const liveUpdate = chatId => { if (ChatUI.mounted && ChatUI.mounted.chatId() === chatId) ChatUI.mounted.updateLive(); };
function replaceMsg(msg, src) {   // the same object, so its open thinking box and 🔊 button stay
  const opens = (msg.steps || []).map(st => st?.open);
  for (const k of Object.keys(msg)) delete msg[k];
  Object.assign(msg, JSON.parse(JSON.stringify(src || {})));
  (msg.steps || []).forEach((st, i) => { if (st && opens[i] !== undefined) st.open = opens[i]; });
}
function followTurn(chat, jid, msg) {
  const cur = ChatUI.live.get(chat.id);
  if (cur?.jid === jid && cur.promise) return cur.promise;
  const live = {chatId: chat.id, jid, msg, n: 0, es: null, since: Date.now(), asked: new Set(), closed: false};
  ChatUI.live.set(chat.id, live);
  ChatRunning.mark(chat.id, true);
  live.promise = new Promise(resolve => {
    const finish = status => {
      if (live.closed) return;
      live.closed = true;
      live.es?.close();
      if (ChatUI.live.get(chat.id) === live) ChatUI.live.delete(chat.id);
      ChatRunning.mark(chat.id, false);
      msg.pending = false;
      msg.status = '';
      resolve(status);
    };
    const take = fn => e => {
      let d;
      try { d = JSON.parse(e.data); } catch { return; }
      if (typeof d.n === 'number') live.n = Math.max(live.n, d.n);
      try { fn(d); } catch (err) { console.error(err); }
      liveUpdate(chat.id);
    };
    let tries = 0;
    const retry = async () => {   // the network dropped, the phone slept or the panel restarted
      if (live.closed) return;
      tries++;
      let job;
      try { job = (await api(`/api/chats/${encodeURIComponent(chat.id)}/turn`)).job; }
      catch { setTimeout(retry, Math.min(15000, 1500 * tries)); return; }   // the panel isn't answering yet
      if (job?.id === jid) { connect(); return; }   // still writing: carry on from the last event
      const rec = await Store.get('chats', chat.id).catch(() => null);   // it ended while we were away
      const saved = rec?.messages?.[chat.messages.indexOf(msg)];
      if (saved?.role === 'assistant') replaceMsg(msg, saved);
      if (msg.pending) { msg.pending = false; if (!msg.content && !msg.error) msg.error = 'Interrupted.'; }
      if (rec?.rev) chat.rev = rec.rev;
      liveUpdate(chat.id);
      finish('gone');
    };
    const connect = () => {
      if (live.closed) return;
      const es = new EventSource(`/api/turns/${encodeURIComponent(jid)}/stream?since=${live.n}&token=${encodeURIComponent(TOKEN)}`);
      live.es = es;
      const announce = (i, st) => {   // a step waiting for your OK: once, also when it was waiting before the page came
        if (st?.status !== 'approval' || live.asked.has(i) || TurnAlerts.seen.has(`${jid}:${i}`)) return;
        live.asked.add(i);
        TurnAlerts.seen.add(`${jid}:${i}`);
        notify('Your Tiiny is waiting for your OK', `${chat.title}: ${st.label}`);
        ChatRunning.refresh();
      };
      es.addEventListener('snapshot', take(d => {
        replaceMsg(msg, d.message); live.n = d.n; if (d.rev) chat.rev = d.rev; tries = 0;
        (msg.steps || []).forEach((st, i) => announce(i, st));
      }));
      es.addEventListener('delta', take(d => { msg.content = (msg.content || '') + (d.c || ''); msg.reasoning = (msg.reasoning || '') + (d.r || ''); }));
      es.addEventListener('set', take(d => { for (const [k, v] of Object.entries(d)) if (k !== 'n') msg[k] = v; }));
      es.addEventListener('step', take(d => {
        const steps = msg.steps || (msg.steps = []);
        const old = steps[d.i];
        if (old) { const open = old.open; for (const k of Object.keys(old)) delete old[k]; Object.assign(old, d.step); if (open !== undefined) old.open = open; }
        else steps[d.i] = d.step;
        announce(d.i, d.step);
      }));
      es.addEventListener('done', take(d => { replaceMsg(msg, d.message); if (d.rev) chat.rev = d.rev; }));
      es.addEventListener('end', take(d => { if (d.rev) chat.rev = d.rev; finish(d.status); }));
      es.onerror = () => { es.close(); if (!live.closed) setTimeout(retry, 1000); };
    };
    connect();
  });
  live.promise.then(() => {
    const ms = msg.meta?.ms || (Date.now() - live.since);
    const model = msg.meta?.model || chat.model;
    Activity.add({kind: 'chat', label: `Chat with ${shortName(model)}${chat.agent ? ' (agent)' : ''}`, ok: !msg.error,
      detail: msg.error || `${(msg.content || '').length} characters in ${(ms / 1000).toFixed(1)} s`, duration: ms / 1000});
    if (ms > 20000) notify(`${shortName(model)} finished replying`, chat.title);
    if (ChatUI.mounted && ChatUI.mounted.chatId() === chat.id) ChatUI.mounted.afterFinish();
  });
  liveUpdate(chat.id);
  return live.promise;
}

/* Have the panel write the reply to the last message, and show it as it comes. The page loads the chat's model first,
   so the “Make room” dialog can ask what to unload: the panel never unloads anything for a reply. */
async function generateReply(chat, view) {
  const model = chat.model || 'default';
  const asst = {role: 'assistant', content: '', reasoning: '', pending: true, status: '', meta: {model, sources: []}, notes: [], steps: []};
  chat.messages.push(asst);
  const starting = {chatId: chat.id, jid: null, msg: asst, n: 0, cancelled: false};
  ChatUI.live.set(chat.id, starting);
  const stopped = () => Object.assign(new Error('Stopped'), {name: 'AbortError'});
  if (view) view.afterStart();
  try {
    if (model !== 'default' && !S.running.has(model)) {
      asst.status = `Loading ${shortName(model)} into NPU memory…`;
      liveUpdate(chat.id);
      if (!(await loadModel(model, {quiet: true}))) throw new Error(`${shortName(model)} wasn’t loaded. Pick another model, or free NPU memory on the Models page.`);
    }
    if (starting.cancelled) throw stopped();
    markUsed(model);
    const saved = await writeChat(chat, {without: asst});   // the chat as it is: the panel adds its own reply
    if (!saved) throw new Error('The chat couldn’t be saved, so the reply wasn’t started.');
    if (saved.messages_kept) {   // it changed in another tab or on another device: show that instead
      ChatUI.live.delete(chat.id);
      takeMessages(chat, saved.messages);
      toast('This chat changed in another tab or on another device', 'info', {detail: 'It’s up to date now. Send your message again if it’s still needed.'});
      return;
    }
    if (starting.cancelled) throw stopped();
    const {job} = await api(`/api/chats/${encodeURIComponent(chat.id)}/turn`, {method: 'POST', body: {}});
    ChatUI.live.delete(chat.id);
    await followTurn(chat, job.id, asst);
  } catch (e) {
    if (ChatUI.live.get(chat.id) === starting) ChatUI.live.delete(chat.id);
    asst.pending = false;
    asst.status = '';
    if (e.name === 'AbortError') asst.meta.stopped = true; else asst.error = e.message || String(e);
    saveChat(chat, 50);
    if (ChatUI.mounted && ChatUI.mounted.chatId() === chat.id) ChatUI.mounted.afterFinish();
  }
}

/* A floating card that shows a cited source. */
function showSourcePopover(anchor, src) {
  closeMenu();
  const where = src.path ? `${src.path}, lines ${src.start_line}–${src.end_line}` : src.kind === 'folder' ? '' : (src.start_line > 1 ? `lines ${src.start_line}–${src.end_line}` : '');
  const box = h('div', {class: 'menu source-pop', role: 'dialog'},
    h('div', {class: 'row', style: {marginBottom: '6px'}}, badge(`[${src.n}]`, 'accent'), h('strong', {class: 'spacer ellipsis', title: src.name}, src.name || 'Source'),
      src.score ? h('span', {class: 'faint small'}, `${Math.round(src.score * 100)}% match`) : null),
    where ? h('div', {class: 'faint small', style: {marginBottom: '6px'}}, where) : null,
    h('div', {class: 'source-text'}, (src.text || '').slice(0, 1600) + ((src.text || '').length > 1600 ? '…' : '')),
    h('div', {class: 'row', style: {marginTop: '8px'}},
      safeUrl(src.url) ? h('a', {class: 'btn sm', href: safeUrl(src.url), target: '_blank', rel: 'noopener noreferrer'}, icon('link'), 'Open page') : null,
      src.project_id && src.doc_id ? btn('Open file', () => viewProjectDoc(src.project_id, src.doc_id, src.name), {small: true, icon: 'file'}) : null,
      btn('Copy passage', () => copyText(src.text || '', 'Passage copied'), {small: true, kind: 'ghost', icon: 'copy'})));
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  box.style.maxWidth = 'min(460px, calc(100vw - 24px))';
  box.style.left = `${clamp(r.left, 8, innerWidth - box.offsetWidth - 8)}px`;
  box.style.top = `${r.bottom + 6 + box.offsetHeight > innerHeight ? Math.max(8, r.top - box.offsetHeight - 6) : r.bottom + 6}px`;
  S.menu = box;
  box.addEventListener('click', e => e.stopPropagation());
  setTimeout(() => document.addEventListener('click', closeMenu, {once: true}), 0);
}

async function chooseProject(current) {
  const projects = await ProjectsAPI.list();
  const v = await formDialog({title: 'Move chat to a project', submitLabel: 'Move',
    intro: 'Chats in a project get its instructions, files and memory.',
    fields: [{name: 'pid', label: 'Project', type: 'select', value: current || '',
      options: [{value: '', label: 'No project'}, ...projects.map(p => ({value: p.id, label: p.name}))]}]});
  return v ? (v.pid || null) : undefined;
}

function viewChat(root, ctx) {
  let attachments = [];
  let current = null;
  const viewToken = {};

  const scopeSel = h('select', {class: 'input sm', 'aria-label': 'Which chats to show'});
  const listEl = h('div', {class: 'chat-list'});
  const projectChip = h('div');
  const modelSel = h('select', {class: 'input', 'aria-label': 'Model'});
  const thinkWrap = h('div', {class: 'row gap-sm'});
  const agentWrap = h('label', {class: 'row gap-sm small', title: 'Agent mode: the model can search the web and your files, read web pages and control the device'});
  const filesBtn = btn('Files', () => openFiles(), {small: true, kind: 'ghost', icon: 'clip'});
  const sysBtn = btn('Instructions', () => editSystem(), {small: true, kind: 'ghost', icon: 'edit'});
  const notice = h('div', {class: 'chat-notice', hidden: true});
  const inner = h('div', {class: 'chat-inner'});
  const scroll = h('div', {class: 'chat-scroll'}, inner);
  const attachRow = h('div', {class: 'attachments'});
  const touch = !!window.matchMedia?.('(pointer: coarse)').matches;
  const textarea = h('textarea', {rows: 1, placeholder: touch ? 'Message your Tiiny…' : 'Message your Tiiny…  (Enter to send, Shift+Enter for a new line)', 'aria-label': 'Message'});
  const fileInput = h('input', {type: 'file', multiple: true, hidden: true});
  const sendBtn = h('button', {class: 'btn primary icon-only', type: 'button', title: 'Send'}, icon('send'));
  const stopBtn = h('button', {class: 'btn icon-only', type: 'button', title: 'Stop generating', hidden: true}, icon('stop'));
  const vaultChk = h('input', {type: 'checkbox'});
  const profileChk = h('input', {type: 'checkbox'});
  const mic = voiceInput({textarea, protect: () => (current?.model && current.model !== 'default' ? current.model : null)});   // voice.js
  const hint = h('span', {class: 'faint'});

  const chatsBtn = btn('Chats', () => setSide(!layout.classList.contains('side-open')), {small: true, kind: 'ghost', icon: 'list', title: 'Your chats'});
  chatsBtn.classList.add('only-narrow');
  const side = h('aside', {class: 'chat-side', 'aria-label': 'Chats'},
    h('div', {class: 'row gap-sm'}, btn('New chat', () => newChat(), {kind: 'primary', icon: 'plus'}), iconBtn('folder', 'Projects', () => go('projects'), {kind: '', small: false})),
    scopeSel, listEl);
  const layout = h('div', {class: 'chat-layout'},
    side,
    h('div', {class: 'chat-backdrop', onclick: () => setSide(false)}),
    h('section', {class: 'chat-main'},
      h('div', {class: 'chat-bar'}, chatsBtn, projectChip, h('span', {class: 'label'}, 'Model'), modelSel, thinkWrap, agentWrap, h('span', {class: 'spacer'}), filesBtn, sysBtn,
        menuButton([
          {label: 'Rename chat', icon: 'edit', fn: renameChat},
          {label: 'Move to a project…', icon: 'folder', fn: moveChat},
          {label: 'Copy as Markdown', icon: 'copy', fn: () => copyText(chatMarkdown(current), 'Chat copied')},
          {label: 'Voice…', icon: 'speaker', fn: voiceSettings},
          {label: 'Agent: ask before actions', icon: 'shield', fn: () => { current.agentAuto = false; current.agentAllow = {}; saveChat(current); toast('Agent will ask before it changes anything', 'ok'); }},
          {label: 'Agent tools…', icon: 'settings', fn: () => go('system?section=agent-tools')},
          {label: 'Agent: never ask in this chat', icon: 'bolt', fn: () => { current.agentAuto = true; saveChat(current); toast('Agent actions run without asking in this chat', 'info', S.health?.commands?.enabled ? {detail: 'Commands and file changes on this computer still ask every time.'} : {}); }},
          {label: 'Clear messages', icon: 'x', fn: clearChat},
          {label: 'Delete chat', icon: 'trash', danger: true, fn: () => deleteChat(current.id)},
        ])),
      notice, scroll,
      h('div', {class: 'composer'}, h('div', {class: 'composer-inner'}, attachRow,
        h('div', {class: 'composer-box'}, h('button', {class: 'btn ghost icon-only', type: 'button', title: 'Attach images, text files or documents', onclick: () => fileInput.click()}, icon('clip')), mic.el, textarea, stopBtn, sendBtn),
        h('div', {class: 'composer-opts'},
          h('label', {title: 'Search your Vault for passages related to each message and give them to the model'}, vaultChk, icon('folder'), 'Use my Vault'),
          h('label', {title: 'Give the model your occupation and preferences from Account → Profile'}, profileChk, icon('user'), 'Use my profile'),
          h('span', {class: 'spacer'}), hint),
        fileInput))));
  root.append(layout);
  // Hooks for the phone layout of the bar (two rows: chats + model + menu, then switches + buttons).
  filesBtn.classList.add('bar-files');
  layout.querySelector('.chat-bar > button[aria-haspopup="menu"]')?.classList.add('bar-menu');
  function setSide(open) {
    layout.classList.toggle('side-open', open);
    chatsBtn.setAttribute('aria-expanded', String(open));
  }
  // Picking or starting a chat closes the slide-in list (deleting one doesn't).
  side.addEventListener('click', e => { if (e.target.closest('.chat-item, .btn') && !e.target.closest('.x')) setTimeout(() => setSide(false), 0); });
  const onKey = e => { if (e.key === 'Escape' && layout.classList.contains('side-open')) setSide(false); };
  document.addEventListener('keydown', onKey);
  ctx.onCleanup(() => document.removeEventListener('keydown', onKey));
  ctx.onCleanup(() => { stopReading(); mic.cancel(); });   // leaving the chat stops reading aloud and recording

  /* ---- data ---- */
  async function pickChat() {
    const wantId = ctx.params[0];
    const wantProject = ctx.query.get('project');
    let pick = null;
    if (ChatUI.preset) {
      const preset = ChatUI.preset;
      ChatUI.preset = null;
      pick = newChatRecord({model: preset});
    } else if (wantProject) {
      pick = newChatRecord({project_id: wantProject, agent: ChatUI.projects.find(p => p.id === wantProject)?.agent});
      ChatUI.scope = wantProject;
    } else if (wantId) {
      try { pick = await loadChat(wantId); } catch { toast('That chat no longer exists', 'err'); }
    }
    if (!pick && ChatUI.currentId) { try { pick = await loadChat(ChatUI.currentId); } catch { pick = null; } }
    if (!pick) {
      const first = visibleSummaries()[0];
      pick = first ? await loadChat(first.id).catch(() => null) : null;
    }
    if (!pick) pick = newChatRecord({project_id: ChatUI.scope !== 'all' && ChatUI.scope !== 'none' ? ChatUI.scope : null});
    if (!current) current = pick;   // (the user may have picked one while this loaded)
  }
  async function boot() {
    if (!ChatUI.migrated) { ChatUI.migrated = true; await migrateBrowserChats(); }
    try {
      const [sums, projects] = await Promise.all([Store.list('chats', ['id', 'title', 'project_id', 'updated']), ProjectsAPI.list()]);
      ChatUI.summaries = sums;
      ChatUI.projects = projects;
    } catch (e) { inner.append(errorBlock(e.message, {title: 'Couldn’t load your chats'})); return; }
    if (!ctx.alive()) return;
    // A chat started or opened while the list was loading (New chat clicked straight away) wins over the automatic pick.
    if (!current) await pickChat();
    if (!ctx.alive()) return;
    ChatUI.cache.set(current.id, current);
    ChatUI.currentId = current.id;
    renderAll();
    if (ChatUI.draft) { textarea.value = ChatUI.draft; ChatUI.draft = null; autosize(); textarea.focus(); }
    if (ChatUI.draftImages?.length) {
      for (const u of ChatUI.draftImages) attachments.push({kind: 'image', name: 'image', dataUrl: u});
      ChatUI.draftImages = null; renderAttachments(); renderNotice(); textarea.focus();
    }
  }

  function visibleSummaries() {
    const s = ChatUI.summaries || [];
    if (ChatUI.scope === 'all') return s;
    if (ChatUI.scope === 'none') return s.filter(c => !c.project_id);
    return s.filter(c => c.project_id === ChatUI.scope);
  }
  const projectName = id => ChatUI.projects.find(p => p.id === id)?.name || 'Project';

  /* ---- rendering ---- */
  function renderScope() {
    clear(scopeSel);
    scopeSel.append(h('option', {value: 'all'}, 'All chats'), h('option', {value: 'none'}, 'Chats without a project'));
    if (ChatUI.projects.length) scopeSel.append(h('optgroup', {label: 'Projects'}, ChatUI.projects.map(p => h('option', {value: p.id}, p.name))));
    if (![...scopeSel.options].some(o => o.value === ChatUI.scope)) ChatUI.scope = 'all';
    scopeSel.value = ChatUI.scope;
  }

  function renderList() {
    clear(listEl);
    const rows = visibleSummaries();
    if (current?.unsaved && !rows.some(r => r.id === current.id)) rows.unshift({id: current.id, title: current.title, project_id: current.project_id});
    if (!rows.length) listEl.append(h('p', {class: 'muted small', style: {padding: '8px'}}, 'No chats here yet.'));
    for (const c of rows) {
      listEl.append(h('div', {class: `chat-item ${c.id === current?.id ? 'active' : ''}`, role: 'button', tabindex: '0',
        onclick: () => openChat(c.id), onkeydown: e => { if (e.key === 'Enter') openChat(c.id); }},
        icon('chat'), h('span', {class: 't', title: c.title}, c.title),
        ChatRunning.map.has(c.id) ? h('span', {class: `chat-dot${ChatRunning.map.get(c.id).waiting ? ' waiting' : ''}`,
          title: ChatRunning.map.get(c.id).waiting ? 'Waiting for your OK' : 'Writing a reply…'}) : null,
        ChatUI.scope === 'all' && c.project_id ? h('span', {class: 'tag', title: projectName(c.project_id)}, projectName(c.project_id)) : null,
        h('button', {class: 'x', type: 'button', title: 'Delete chat', onclick: e => { e.stopPropagation(); deleteChat(c.id); }}, icon('x'))));
    }
  }

  function renderHeader() {
    clear(projectChip);
    if (current.project_id) {
      projectChip.append(h('a', {class: 'chip active', href: `#/projects/${current.project_id}`, title: 'Open the project'}, icon('folder'), projectName(current.project_id)));
    }
    clear(agentWrap).append(switchInput(!!current.agent, v => { current.agent = v; saveChat(current); renderHeader(); renderHint(); }, 'Agent mode'),
      h('span', {class: 'label'}, 'Agent'));
    const n = current.pinned_count || 0;
    filesBtn.querySelector('span:last-child').textContent = n ? `Files (${n})` : 'Files';
    filesBtn.classList.toggle('primary', n > 0);
    sysBtn.classList.toggle('primary', !!(current.system || '').trim());
    renderModelSelect();
  }

  function renderModelSelect() {
    const {loaded, other} = chatModels();
    clear(modelSel);
    modelSel.append(h('option', {value: 'default'}, 'Auto: the device picks a loaded model'));
    if (loaded.length) modelSel.append(h('optgroup', {label: 'Loaded'}, loaded.map(m => h('option', {value: m.id}, `● ${m.display_name || m.name}`))));
    if (other.length) modelSel.append(h('optgroup', {label: 'On the device (loads when you send)'}, other.map(m => h('option', {value: m.id}, `${m.display_name || m.name}${m.load_time ? `  · ~${fmtSecs(m.load_time)} to load` : ''}`))));
    if (current.model !== 'default' && !S.modelsById.has(current.model)) modelSel.append(h('option', {value: current.model}, current.model));
    modelSel.value = current.model;
    renderThinking();
    renderNotice();
  }

  function renderThinking() {
    clear(thinkWrap);
    const opts = thinkingOptions(current);
    if (!opts) return;
    if (opts.toggleable && decisionOn('chat_thinking')) {   // Off / On / Auto (a decision model decides per message)
      const v = opts.auto ? 'auto' : opts.enabled ? 'on' : 'off';
      thinkWrap.append(h('label', {class: 'row gap-sm small', title: 'Let the model reason before answering. Auto: a decision model decides for each message.'},
        h('span', {class: 'label'}, 'Thinking'),
        h('select', {class: 'input sm', style: {width: 'auto'}, 'aria-label': 'Thinking', onchange: e => {
          current.thinking = e.target.value === 'auto' ? 'auto' : e.target.value === 'on'; saveChat(current); renderThinking();
        }}, [['off', 'Off'], ['on', 'On'], ['auto', 'Auto']].map(([k, l]) => h('option', {value: k, selected: k === v}, l)))));
    } else if (opts.toggleable) {
      thinkWrap.append(h('label', {class: 'row gap-sm small', title: 'Let the model reason before answering'},
        switchInput(opts.enabled, v => { current.thinking = v; saveChat(current); renderThinking(); }, 'Thinking'), h('span', {class: 'label'}, 'Thinking')));
    } else thinkWrap.append(badge('Always thinks', '', 'brain'));
    if (opts.levels.length && opts.enabled && !opts.auto) {
      thinkWrap.append(h('select', {class: 'input sm', style: {width: 'auto'}, 'aria-label': 'Thinking depth', onchange: e => { current.depth = e.target.value; saveChat(current); }},
        opts.levels.map(l => h('option', {value: l, selected: l === opts.level}, l))));
    }
  }

  function renderNotice() {
    clear(notice);
    notice.hidden = true;
    const show = (...kids) => { notice.hidden = false; append(notice, kids); };
    if (S.modelsAt && !modelsOf('chat').length) {
      show(icon('info'), h('span', {}, 'There are no chat models on your device yet.'), btn('Get one from the store', () => { sessionStorage.setItem('tiiny.modelsTab', 'store'); go('models'); }, {small: true}));
      return;
    }
    if (current.model === 'default' && S.modelsAt && !chatModels().loaded.length && !S.loading.size) {
      const first = chatModels().other.slice().sort((a, b) => (a.load_time || 999) - (b.load_time || 999))[0];
      show(icon('info'), h('span', {}, 'No chat model is loaded. Pick one above (it loads when you send), or load one now.'),
        first ? btn(`Load ${first.display_name || first.name}`, async () => { current.model = first.id; saveChat(current); renderModelSelect(); await loadModel(first.id); }, {small: true, icon: 'play'}) : null);
      return;
    }
    const loading = S.loading.get(current.model);
    if (current.model !== 'default' && !S.running.has(current.model) && S.modelsById.has(current.model)) {
      const m = S.modelsById.get(current.model);
      if (loading) show(h('span', {class: 'spinner'}), h('span', {}, `Loading ${m.display_name || m.name}…${loading.pct !== null ? ` ${Math.round(loading.pct)}%` : ''}`));
      else show(icon('info'), h('span', {}, `${m.display_name || m.name} isn’t loaded yet. It loads automatically when you send${m.load_time ? ` (about ${fmtSecs(m.load_time)})` : ''}.`),
        btn('Load now', () => loadModel(current.model), {small: true, icon: 'play'}));
    }
    const vis = S.modelsById.get(current.model);
    if (attachments.some(a => a.kind === 'image') && vis && !isVision(vis)) show(h('span', {}, ` · ${vis.display_name || vis.name} can’t see images; pick a vision model.`));
  }

  function renderHint() {
    const bits = [];
    if (current.agent) bits.push(current.agentAuto ? 'Agent mode (acts without asking)' : 'Agent mode (asks before actions)');
    if (current.project_id) bits.push(`Project: ${projectName(current.project_id)}`);
    if (current.pinned_count) bits.push(`${current.pinned_count} file(s) pinned`);
    hint.textContent = bits.join(' · ') || `Chats are saved on ${hereName()}.`;
    hint.classList.toggle('default-hint', !bits.length);
  }

  function renderSteps(m) {
    if (!m.steps?.length) return null;
    const statusIcon = st => st.status === 'running' ? h('span', {class: 'spinner'}) : icon(st.status === 'done' ? 'check' : st.status === 'approval' ? 'shield' : st.status === 'denied' ? 'x' : st.status === 'error' ? 'alert' : 'bolt');
    const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
    const preview = rows => h('div', {class: 'step-preview'}, rows.map(([label, text, kind]) => h('div', {class: 'pv-row'},
      h('span', {class: 'pv-label'}, label),
      kind === 'code' ? h('code', {class: 'block pv-code'}, text) : kind === 'pre' ? h('pre', {class: 'pv-pre'}, text || '(empty)')
        : kind === 'img' ? h('img', {class: 'pv-img', alt: '', src: /^\/api\//.test(text) ? withToken(text) : text}) : h('span', {}, text))));
    return h('div', {class: 'agent-steps'}, m.steps.map(st => {
      if (st.type === 'thought') return h('div', {class: 'step thought'}, icon('spark'), h('span', {}, st.text));
      const body = h('div', {class: 'step-body'},
        st.preview?.length ? preview(st.preview) : Object.keys(st.args || {}).length ? h('pre', {}, JSON.stringify(st.args, null, 2)) : null,
        st.error ? h('div', {class: 'msg-error'}, st.error)
          : st.links?.length ? h('ol', {class: 'step-links'}, st.links.map(l => h('li', {},
            /^#\/[\w/?=&.-]*$/.test(l.href || '') ? h('a', {href: '/' + l.href, target: '_blank', rel: 'noopener'}, l.title || l.href)  // a page of the panel (history)
              : safeUrl(l.url) ? h('a', {href: safeUrl(l.url), target: '_blank', rel: 'noopener noreferrer', title: l.url}, l.title || l.url) : h('span', {}, l.title || l.url || ''),
            h('span', {class: 'faint small'}, ` ${l.sub || host(l.url)}`))))
          : st.output !== undefined ? h('pre', {class: 'step-result step-output'}, st.output || '(no output)')
          : st.result ? h('pre', {class: 'step-result'}, st.result) : null,
        st.image ? h('img', {src: withToken(st.image), alt: 'generated image', class: 'result-img', style: {maxHeight: '320px', marginTop: '6px'},
          onerror: e => e.target.replaceWith(h('div', {class: 'muted small'}, 'This image isn’t available here any more. Images the agent makes are kept in the Gallery.'))}) : null);
      // Your own opening or closing of a step sticks while the reply keeps streaming.
      const card = h('details', {class: `step ${st.status}`, open: st.status === 'approval' || (st.open ?? !!st.image)},
        h('summary', {onclick: () => { if (st.status !== 'approval') st.open = !card.open; }}, statusIcon(st), h('span', {class: 'spacer'}, st.label),
          st.status === 'running' && st.progress ? h('span', {class: 'faint small'}, st.progress) : st.summary ? h('span', {class: 'faint small'}, st.summary) : null,
          st.status === 'denied' ? badge('Skipped') : null), body);
      if (st.status === 'approval') {
        const pc = onServer() ? 'the server' : 'your computer';
        const what = {network: 'This goes to the internet.', command: `This runs a command on ${pc}${onServer() ? '' : ', with your rights'}.`,
          file: `This writes a file on ${pc}.`, computer: `This looks at files on ${pc}.`,
          open: `This opens something on ${pc}.`}[st.risk] || 'This changes something.';
        const pcOnly = !!S.health?.remote && ['command', 'file', 'open', 'computer'].includes(st.risk);   // allowed only on the computer
        const ask = h('div', {class: `approval${st.alwaysAsk ? ' every-time' : ''}`},
          h('span', {}, what, st.note ? ` ${st.note}` : '', st.alwaysAsk ? ' You’re asked every time.' : '',
            pcOnly ? (onServer() ? ' You can allow it only on a device with full access.' : ' You can allow it only on the computer running the panel.') : ' Allow it?'),
          h('div', {class: 'row gap-sm'},
            pcOnly ? null : btn({command: 'Run it', file: 'Write it', open: 'Open it'}[st.risk] || 'Allow', () => decide(st, 'once'), {small: true, kind: 'primary'}),
            st.alwaysAsk || pcOnly ? null : btn('Always in this chat', () => decide(st, 'always'), {small: true}),
            btn('Don’t', () => decide(st, 'deny'), {small: true, kind: 'ghost'})));
        if (st.preview?.length) body.append(ask); else body.prepend(ask);   // a command or file: show it first, then ask
      }
      return card;
    }));
  }
  async function decide(st, decision) {   // the panel waits for the answer (tiinyui/turns.py)
    const live = current && ChatUI.live.get(current.id);
    const i = live?.msg.steps?.indexOf(st) ?? -1;
    if (!live?.jid || i < 0) return;
    const before = st.status;
    st.status = decision === 'deny' ? 'denied' : 'running';
    updateLive();
    try { await api(`/api/turns/${encodeURIComponent(live.jid)}/approve`, {method: 'POST', body: {step: i, decision}}); }
    catch (e) { if (st.status !== 'done') { st.status = before; updateLive(); } toast('Couldn’t answer', 'err', {detail: e.message}); }
  }

  function renderMsg(m, isLast) {
    if (m.role === 'user') {
      return h('div', {class: 'msg user'}, h('div', {class: 'body'},
        m.images?.length ? h('div', {class: 'msg-images'}, m.images.map(u => h('img', {src: u, alt: 'attached image'}))) : null,
        m.docs?.length ? h('div', {class: 'msg-files'}, m.docs.map(d => h('span', {class: 'file-chip'}, icon('file'), h('span', {}, d.name)))) : null,
        m.content ? h('div', {class: 'bubble'}, m.content) : null));
    }
    const {reasoning, answer} = splitThinking(m);
    const live = !!m.pending;
    const sources = m.meta?.sources || [];
    const cites = new Set(sources.map(s => s.n));
    const cited = new Set([...String(answer).matchAll(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g)].flatMap(x => x[1].split(',').map(n => Number(n.trim()))));
    const meta = [];
    if (m.meta?.model) meta.push(shortName(m.meta.model));
    if (m.meta?.usage?.completion_tokens) meta.push(`${m.meta.usage.completion_tokens} tokens`);
    if (m.meta?.tps) meta.push(`${m.meta.tps.toFixed(1)} tok/s`);
    if (m.meta?.ms) meta.push(`${(m.meta.ms / 1000).toFixed(1)} s`);
    if (m.meta?.stopped) meta.push('stopped');
    if (m.meta?.finish === 'length') meta.push('cut off (length limit)');
    const thinkingNow = live && !answer;
    const think = reasoning ? h('details', {class: 'think', open: ThinkOpen.has(m) ? ThinkOpen.get(m) : thinkingNow},
      h('summary', {onclick: e => ThinkOpen.set(m, !e.currentTarget.parentElement.open)}, icon('chevron'),
        h('span', {class: 'think-label'}, thinkingNow ? 'Thinking…' : 'Thought process')),
      h('div', {class: 'think-body'}, reasoning)) : null;
    const shownSources = sources.filter(s => cited.has(s.n));
    const otherSources = sources.filter(s => !cited.has(s.n));
    return h('div', {class: 'msg assistant'}, h('div', {class: 'avatar'}, icon('spark')), h('div', {class: 'body', dataset: {msg: '1'}},
      renderSteps(m),
      think,
      answer ? h('div', {class: 'md', html: renderMarkdown(answer, {cites})}) : null,
      live && !answer && !m.steps?.some(s => s.status === 'approval') ? h('div', {class: 'typing'}, m.status ? h('span', {}, m.status) : [h('i'), h('i'), h('i')]) : null,
      !live && sources.length ? h('div', {class: 'sources'}, h('span', {class: 'faint small'}, 'Sources:'),
        (shownSources.length ? shownSources : sources.slice(0, 6)).map(s => h('button', {type: 'button', class: 'chip src', dataset: {cite: String(s.n)}, title: s.name},
          h('b', {}, `[${s.n}]`), ' ', String(s.name || 'source').slice(0, 40))),
        shownSources.length && otherSources.length ? h('span', {class: 'faint small'}, `+${otherSources.length} more used as context`) : null) : null,
      m.error ? h('div', {class: 'msg-error'}, m.error) : null,
      (m.notes || []).map(n => h('div', {class: 'msg-note'}, n)),
      !live ? h('div', {class: 'msg-meta'}, meta.join(' · '),
        answer ? h('button', {class: 'btn ghost sm', type: 'button', onclick: () => copyText(answer, 'Reply copied')}, icon('copy'), 'Copy') : null,
        answer ? readAloudButton(answer, readKey(m)) : null,
        isLast ? h('button', {class: 'btn ghost sm', type: 'button', onclick: regenerate}, icon('refresh'), 'Regenerate') : null) : null));
  }

  function renderMessages() {
    clear(inner);
    if (!current.messages.length) {
      const proj = current.project_id ? ChatUI.projects.find(p => p.id === current.project_id) : null;
      inner.append(h('div', {class: 'chat-empty'}, icon(proj ? 'folder' : 'spark'), h('h3', {}, proj ? proj.name : 'What can I help with?'),
        h('p', {}, proj ? `This chat uses the project’s instructions${proj.docs ? `, its ${proj.docs} file(s)` : ''}${proj.memory ? ` and ${proj.memory} remembered fact(s)` : ''}.`
          : 'Everything runs on your Tiiny; nothing leaves your network.'),
        h('div', {class: 'suggestions'}, (proj ? [
          ['Summarize the files in this project', false], ['What decisions have we made so far?', false], ['What should I do next?', false],
        ] : [
          ['Explain how a transformer works in plain words', false],
          ['Write a short poem about running AI at home', false],
          ['Summarize what is in my Vault', true],
          ['How busy is my Tiiny right now?', 'agent'],
        ]).map(([s, flag]) => h('button', {class: 'chip', type: 'button', onclick: () => {
          if (flag === true) { current.useVault = true; vaultChk.checked = true; }
          if (flag === 'agent') { current.agent = true; renderHeader(); }
          textarea.value = s;
          send();
        }}, s)))));
      return;
    }
    current.messages.forEach((m, i) => inner.append(renderMsg(m, i === current.messages.length - 1)));
    if (current.messages[current.messages.length - 1]?.pending) followThink(inner.lastElementChild);
    scroll.scrollTop = scroll.scrollHeight;
  }

  let raf = 0;
  function updateLive() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const live = current && ChatUI.live.get(current.id);
      if (ChatUI.mounted !== api_ || !live || current.messages[current.messages.length - 1] !== live.msg) return;
      const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140;
      const last = inner.lastElementChild;
      const node = renderMsg(live.msg, true);
      if (last && last.classList.contains('assistant')) {
        if (!patchLiveMsg(last, node)) { last.replaceWith(node); followThink(node); }
      } else { inner.append(node); followThink(node); }
      if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
    });
  }

  function renderComposerState() {
    const streaming = ChatUI.live.has(current.id);
    sendBtn.hidden = !!streaming;
    stopBtn.hidden = !streaming;
    vaultChk.checked = !!current.useVault;
    profileChk.checked = !!current.useProfile;
    renderHint();
  }

  function renderAttachments() {
    clear(attachRow);
    for (const a of attachments) {
      attachRow.append(h('span', {class: 'file-chip'}, a.kind === 'image' ? h('img', {src: a.dataUrl, alt: ''}) : icon('file'),
        h('span', {title: a.name}, a.name), h('button', {type: 'button', title: 'Remove', onclick: () => { attachments = attachments.filter(x => x !== a); renderAttachments(); renderNotice(); }}, icon('x'))));
    }
  }

  function renderAll() {
    renderScope();
    renderList();
    renderHeader();
    renderMessages();
    renderComposerState();
    renderAttachments();
    ctx.setTitle(current.project_id ? `Chat · ${projectName(current.project_id)}` : 'Chat', 'Talk to the models on your device');
  }

  /* ---- actions ---- */
  async function openChat(id) {
    try { current = await loadChat(id); } catch (e) { toast('Couldn’t open that chat', 'err', {detail: e.message}); return; }
    ChatUI.currentId = id;
    attachments = [];
    history.replaceState(null, '', `#/chat/${id}`);
    renderAll();
  }

  async function ensureKnowledge() {
    if (current.knowledge_id) return current.knowledge_id;
    if (current.unsaved) await writeChat(Object.assign(current, {unsaved: undefined}));
    const p = await ProjectsAPI.create({hidden: true, chat_id: current.id, name: `Files for “${current.title}”`});
    current.knowledge_id = p.id;
    saveChat(current, 0);
    return p.id;
  }

  async function openFiles() {
    const kid = await ensureKnowledge();
    const body = h('div', {class: 'stack'}, h('p', {class: 'muted small'},
      'These files are used for every answer in this chat, with numbered citations. Small files are read in full; bigger ones are searched for the passages that matter.'));
    const holder = h('div');
    body.append(holder);
    modal({title: 'Files for this chat', size: 'wide', body});
    KnowledgeManager(holder, kid, {compact: true, onChange: p => { current.pinned_count = (p.docs || []).length; saveChat(current); renderHeader(); renderHint(); }});
  }

  async function addFiles(files) {
    for (const f of files) {
      if (f.type.startsWith('image/')) {
        try { attachments.push({kind: 'image', name: f.name || 'image', dataUrl: await shrinkImage(f, 1600)}); }
        catch (e) { toast(`Couldn’t read ${f.name}`, 'err', {detail: e.message}); }
      } else if ((f.type.startsWith('text/') || TEXT_EXT.test(f.name)) && f.size <= 400 * 1024) {
        attachments.push({kind: 'doc', name: f.name, text: await readAs(f, 'text')});
      } else if (DOC_EXT.test(f.name) || f.type.startsWith('text/') || TEXT_EXT.test(f.name)) {
        let target = 'chat';
        if (current.project_id) {
          const v = await formDialog({title: `Add ${f.name}`, submitLabel: 'Add', fields: [{name: 'where', label: 'Where should this file go?', type: 'select', value: 'project',
            options: [{value: 'project', label: `The project “${projectName(current.project_id)}” (all its chats)`}, {value: 'chat', label: 'Only this chat'}]}]});
          if (!v) continue;
          target = v.where;
        }
        const dismiss = toast(`Reading ${f.name}…`, 'info', {timeout: 600000});
        try {
          const pid = target === 'project' ? current.project_id : await ensureKnowledge();
          const up = await uploadFile(f);
          await ProjectsAPI.addDoc(pid, {kind: 'upload', file_id: up.id});
          dismiss();
          if (target === 'chat') { current.pinned_count = (current.pinned_count || 0) + 1; saveChat(current); renderHeader(); renderHint(); }
          toast(`${f.name} is ready`, 'ok', {detail: target === 'project' ? 'Every chat in the project can use it now.' : 'Ask about it; answers cite the passages they use.'});
        } catch (e) {
          dismiss();
          toast(`Couldn’t add ${f.name}`, 'err', {detail: e.message, action: {label: 'Add to Vault instead', fn: () => VaultUploader.enqueue([f])}});
        }
      } else {
        toast(`${f.name} can’t be read in chat`, 'err', {detail: 'Images, text, PDF and Office documents work. Audio goes to Playground → Transcribe.'});
      }
    }
    renderAttachments();
    renderNotice();
  }

  async function send() {
    if (mic.busy()) { mic.finish(); return; }   // still recording: write it down first, then you send it
    const text = textarea.value.trim();
    if (!text && !attachments.length) return;
    if (ChatUI.live.has(current.id)) { toast('Wait for the current reply to finish, or stop it first', 'info'); return; }
    const docs = attachments.filter(a => a.kind === 'doc');
    const msg = {role: 'user', content: text, images: attachments.filter(a => a.kind === 'image').map(a => a.dataUrl),
      docs: docs.map(d => ({name: d.name})), docText: docs.map(d => `<file name="${d.name}">\n${d.text}\n</file>`).join('\n\n')};
    if (!msg.images.length) delete msg.images;
    if (!docs.length) { delete msg.docs; delete msg.docText; }
    current.messages.push(msg);
    if (current.title === 'New chat') current.title = (text || docs[0]?.name || 'Image').replace(/\s+/g, ' ').slice(0, 60);
    textarea.value = '';
    autosize();
    attachments = [];
    chatPrefs({model: current.model});
    saveChat(current, 0);
    history.replaceState(null, '', `#/chat/${current.id}`);
    renderAll();
    await generateReply(current, viewApi);
  }

  function stop() {   // the panel stops writing and interrupts the model on the device
    const live = current && ChatUI.live.get(current.id);
    if (!live) return;
    if (!live.jid) { live.cancelled = true; return; }   // still loading the model: it won't start
    api(`/api/turns/${encodeURIComponent(live.jid)}/stop`, {method: 'POST', body: {}}).catch(e => toast('Couldn’t stop the reply', 'err', {detail: e.message}));
  }
  function regenerate() {
    if (ChatUI.live.has(current.id)) return;
    while (current.messages.length && current.messages[current.messages.length - 1].role === 'assistant') current.messages.pop();
    if (!current.messages.length) return;
    renderMessages();
    generateReply(current, viewApi);
  }
  function newChat() {
    if (current && current.unsaved && !current.messages.length) { textarea.focus(); return; }
    const scopeProject = ChatUI.scope !== 'all' && ChatUI.scope !== 'none' ? ChatUI.scope : null;
    current = newChatRecord({project_id: scopeProject, model: current?.model, agent: scopeProject ? ChatUI.projects.find(p => p.id === scopeProject)?.agent : undefined});
    ChatUI.cache.set(current.id, current);
    ChatUI.currentId = current.id;
    attachments = [];
    history.replaceState(null, '', '#/chat');
    renderAll();
    textarea.focus();
  }
  async function deleteChat(id) {
    const c = ChatUI.cache.get(id) || (ChatUI.summaries || []).find(x => x.id === id);
    if (!c) return;
    const hasContent = (c.messages ? c.messages.length : 1) > 0;
    if (hasContent && !(await confirmDialog({title: 'Delete this chat?', message: `“${c.title}” and the files pinned to it will be deleted.`, confirmLabel: 'Delete', danger: true}))) return;
    const live = ChatUI.live.get(id);
    if (live?.jid) api(`/api/turns/${encodeURIComponent(live.jid)}/stop`, {method: 'POST', body: {}}).catch(() => {});
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    ChatUI.cache.delete(id);
    ChatUI.summaries = (ChatUI.summaries || []).filter(x => x.id !== id);
    if (!c.unsaved) await Store.del('chats', id).catch(e => toast('Couldn’t delete the chat', 'err', {detail: e.message}));
    if (current?.id === id) {
      current = null;
      const first = visibleSummaries()[0];
      if (first) { await openChat(first.id); return; }
      newChat();
      return;
    }
    renderList();
  }
  async function renameChat() {
    const v = await formDialog({title: 'Rename chat', fields: [{name: 'title', label: 'Title', value: current.title, required: true, maxlength: 80}]});
    if (v) { current.title = v.title; saveChat(current); renderList(); }
  }
  async function moveChat() {
    const pid = await chooseProject(current.project_id);
    if (pid === undefined) return;
    current.project_id = pid;
    saveChat(current);
    renderAll();
    toast(pid ? `Moved to “${projectName(pid)}”` : 'Removed from the project', 'ok');
  }
  async function clearChat() {
    if (!current.messages.length) return;
    if (await confirmDialog({title: 'Clear all messages?', message: 'The chat and its pinned files stay; its messages are removed.', confirmLabel: 'Clear', danger: true})) {
      current.messages = [];
      saveChat(current);
      renderMessages();
    }
  }
  async function editSystem() {
    const v = await formDialog({title: 'Instructions for this chat', size: 'wide',
      intro: current.project_id ? 'These are added to the project’s own instructions.' : 'Standing instructions the model follows in this chat: a role, tone, language or format.',
      fields: [{name: 'system', label: 'Instructions', type: 'textarea', rows: 7, value: current.system, placeholder: 'You are a concise assistant who answers in British English…'}]});
    if (v) { current.system = v.system; saveChat(current); renderHeader(); }
  }
  function autosize() { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`; }

  scopeSel.addEventListener('change', () => { ChatUI.scope = scopeSel.value; renderList(); });
  modelSel.addEventListener('change', () => { current.model = modelSel.value; current.depth = null; current.thinking = null; saveChat(current); chatPrefs({model: current.model}); renderThinking(); renderNotice(); });
  vaultChk.addEventListener('change', () => { current.useVault = vaultChk.checked; saveChat(current); });
  profileChk.addEventListener('change', () => { current.useProfile = profileChk.checked; chatPrefs({useProfile: profileChk.checked}); saveChat(current); });
  textarea.addEventListener('input', autosize);
  textarea.addEventListener('keydown', e => {
    if (mic.busy() && !e.isComposing && (e.key === 'Enter' || e.key === 'Escape')) {   // recording: Enter writes it down, Esc throws it away
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Enter') mic.finish(); else mic.cancel();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch) { e.preventDefault(); send(); }
  });
  textarea.addEventListener('paste', e => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } });
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', stop);
  scroll.addEventListener('click', e => {
    const b = e.target.closest('[data-cite]');
    if (!b) return;
    e.stopPropagation();
    const body = b.closest('[data-msg]');
    const idx = [...inner.children].indexOf(body?.closest('.msg'));
    const m = idx >= 0 ? current.messages[idx] : null;
    const src = (m?.meta?.sources || []).find(s => s.n === Number(b.dataset.cite));
    if (src) showSourcePopover(b, src);
  });
  S.dropHandler = files => addFiles(files);

  const viewApi = {
    afterStart() { if (ChatUI.mounted === api_ && current) { renderMessages(); renderComposerState(); } },
  };
  const api_ = {chatId: () => current?.id, updateLive, renderList: () => current && renderList(),
    afterFinish: () => { renderMessages(); renderComposerState(); renderList(); }};
  ChatUI.mounted = api_;
  // A reply started somewhere else (another tab, your phone, a routine) in the chat that's open shows up live.
  const poll = setInterval(async () => {
    await ChatRunning.refresh();
    if (!ctx.alive() || !current || current.unsaved || !ChatRunning.changed(current)) return;
    const c = await loadChat(current.id).catch(() => null);
    if (c && ctx.alive() && current?.id === c.id) { current = c; renderAll(); }
  }, 4000);
  ctx.onCleanup(() => clearInterval(poll));
  ChatRunning.refresh();
  ctx.onCleanup(() => { if (ChatUI.mounted === api_) ChatUI.mounted = null; void viewToken; });
  ctx.on('models', () => current && renderModelSelect());
  ctx.on('running', () => current && renderModelSelect());
  ctx.on('loading', () => current && renderNotice());
  inner.append(loadingBlock('Loading your chats…'));
  boot();
  if (!S.modelsAt) refreshModels();
  refreshRunning();
  setTimeout(() => textarea.focus(), 50);
}

registerView({id: 'chat', order: 30, group: 'main', title: 'Chat', ic: 'chat', sub: 'Talk to the models on your device', render: viewChat, wide: true});
