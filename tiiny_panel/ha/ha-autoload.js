/* Home Assistant add-on part (not in the upstream Tiiny Control Panel).
   Adds an "Auto-load" button to the top bar. It opens a list of the models on your Tiiny; the ticked ones are
   loaded automatically after the Tiiny is unlocked again (tiinyui/ha_watch.py does the loading). */
(() => {
  'use strict';
  const bar = document.querySelector('.topbar-actions');
  if (!bar) return;
  const token = () => document.querySelector('meta[name="tiiny-token"]')?.content || '';
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    if (props.css) n.style.cssText = props.css;
    n.append(...kids.filter(k => k !== null && k !== undefined));
    return n;
  };
  const api = async body => {
    const r = await fetch('api/ha/autoload', {
      method: body ? 'POST' : 'GET',
      headers: {'X-Tiiny-Token': token(), ...(body ? {'Content-Type': 'application/json'} : {})},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `The panel answered ${r.status}.`);
    return data;
  };
  const size = m => (typeof m.npu_usage === 'number' && m.npu_usage > 0 ? `${m.npu_usage}% of the NPU memory` : '');

  const dlg = el('dialog', {id: 'ha-autoload', css: 'border:1px solid var(--border);border-radius:var(--radius);background:var(--panel);color:var(--text);padding:0;width:min(560px,94vw);max-height:86vh;box-shadow:var(--shadow-lg)'});
  const list = el('div', {css: 'display:grid;gap:2px;max-height:46vh;overflow:auto;margin:10px 0'});
  const total = el('p', {css: 'margin:0;font-size:12.5px'});
  const note = el('p', {className: 'muted', css: 'margin:8px 0 0;font-size:12.5px;overflow-wrap:anywhere'});
  const msg = el('p', {css: 'margin:8px 0 0;font-size:12.5px;min-height:1.4em;overflow-wrap:anywhere'});
  const save = el('button', {className: 'btn primary', type: 'button', textContent: 'Save'});
  const now = el('button', {className: 'btn', type: 'button', textContent: 'Save and load now'});
  const close = el('button', {className: 'btn ghost', type: 'button', textContent: 'Close'});
  dlg.append(el('div', {css: 'padding:18px 20px'},
    el('h2', {textContent: 'Load after unlock', css: 'margin:0 0 4px;font-size:17px'}),
    el('p', {className: 'muted', css: 'margin:0', textContent: 'Ticked models are loaded automatically, top to bottom, when your Tiiny is unlocked again after a restart.'}),
    list, total, note, msg,
    el('div', {css: 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px'}, close, now, save)));
  document.body.append(dlg);

  const say = (text, bad = false) => { msg.textContent = text; msg.style.color = bad ? 'var(--err)' : 'var(--ok)'; };
  const picked = () => [...list.querySelectorAll('input:checked')].map(i => i.value);
  const sum = () => {
    const pct = [...list.querySelectorAll('input:checked')].reduce((a, i) => a + (Number(i.dataset.pct) || 0), 0);
    total.textContent = pct ? `Ticked models need about ${Math.round(pct * 10) / 10}% of the NPU memory.${pct > 100 ? ' That is more than fits: the last ones will fail to load.' : ''}` : '';
    total.style.color = pct > 100 ? 'var(--err)' : 'var(--muted)';
  };
  list.addEventListener('change', sum);
  const show = d => {
    list.replaceChildren();
    const known = new Set(d.models.map(m => m.id));
    const rows = [...d.models, ...d.selected.filter(id => !known.has(id)).map(id => ({id, name: id.split('/').pop(), type: 'not on the Tiiny right now', gone: true}))];
    if (!rows.length) list.append(el('p', {className: 'muted', textContent: d.error ? `The model list isn't available: ${d.error}` : 'No models are downloaded yet.'}));
    for (const m of rows) {
      const box = el('input', {type: 'checkbox', value: m.id, checked: d.selected.includes(m.id), css: 'margin:3px 0 0;flex:none'});
      box.dataset.pct = typeof m.npu_usage === 'number' ? m.npu_usage : 0;
      list.append(el('label', {css: 'display:flex;gap:10px;align-items:flex-start;padding:7px 8px;border-radius:var(--radius-xs);cursor:pointer'}, box,
        el('span', {css: 'min-width:0;overflow-wrap:anywhere'}, el('strong', {textContent: m.name, css: 'font-weight:600'}),
          el('span', {className: 'muted', css: 'display:block;font-size:12.5px', textContent: [m.type, size(m)].filter(Boolean).join(' · ')}))));
    }
    const parts = [d.auto_unlock
      ? `Automatic unlock is on${d.password_set ? ', with the password as a fallback' : ''}.`
      : 'Automatic unlock is off (add-on Configuration tab): the models load after you log in yourself.'];
    if (d.error && rows.length) parts.push(`The model list isn't available right now: ${d.error}`);
    if (d.busy) parts.push('Loading models now…');
    else if (d.last) parts.push(`Last run${d.last_at ? ' (' + new Date(d.last_at * 1000).toLocaleString() + ')' : ''}: ${d.last}`);
    note.textContent = parts.join(' ');
    sum();
  };
  const run = async (body, done) => {
    save.disabled = now.disabled = true;
    try { show(await api(body)); if (done) say(done); } catch (e) { say(e.message, true); }
    save.disabled = now.disabled = false;
  };
  save.addEventListener('click', () => run({selected: picked()}, 'Saved.'));
  now.addEventListener('click', () => run({selected: picked(), load_now: true}, 'Saved. Loading starts within a few seconds; the result shows here when you open this again.'));
  close.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  const btn = el('button', {className: 'btn ghost', id: 'ha-autoload-btn', type: 'button', title: 'Models to load automatically after your Tiiny is unlocked', textContent: 'Auto-load'});
  btn.addEventListener('click', () => { msg.textContent = ''; list.replaceChildren(el('p', {className: 'muted', textContent: 'Loading the list…'})); note.textContent = ''; dlg.showModal(); run(null); });
  bar.prepend(btn);
})();
