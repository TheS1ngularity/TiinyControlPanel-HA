/* Performance: history charts, the NPU memory planner bar, the speed leaderboard and idle-unload settings. */
'use strict';

const PerfAPI = {
  metrics: range => api(`/api/metrics?range=${encodeURIComponent(range)}`),
  speed: async () => (await api('/api/metrics/speed')).models,
  idle: () => api('/api/metrics/idle'),
};
const PERF_SERIES = [['npu', 'NPU compute'], ['npu_mem', 'NPU memory'], ['cpu', 'CPU'], ['ram', 'RAM']];
const SLOT_COUNT = 6;
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

function fmtClockTime(t, span) {
  const d = new Date(t * 1000);
  if (span > 86400 * 1.5) return d.toLocaleDateString([], {weekday: 'short', day: 'numeric'});
  return d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}
function timeTicks(start, end) {
  const span = end - start;
  const steps = [60, 300, 900, 1800, 3600, 7200, 3 * 3600, 6 * 3600, 12 * 3600, 86400];
  const step = steps.find(s => span / s <= 5) || 86400;
  const off = new Date().getTimezoneOffset() * 60;  // align ticks to local clock time
  const out = [];
  for (let t = Math.ceil((start - off) / step) * step + off; t <= end; t += step) out.push(t);
  return out;
}

/* Four small line charts that share one time axis and one crosshair. */
function historyCard(ctx) {
  let range = localStorage.getItem('tiiny.perfRange') || '1h';
  let data = null;
  const grid = h('div', {class: 'perf-grid'});
  const note = h('div', {class: 'small muted'});
  const tableBox = h('details', {class: 'perf-table'}, h('summary', {class: 'small'}, 'Show the numbers'));
  tableBox.addEventListener('toggle', () => { if (tableBox.open) renderTable(); });
  const seg = segmented([['15m', '15 min'], ['1h', '1 hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days']], range, v => {
    range = v; localStorage.setItem('tiiny.perfRange', v); grid.classList.add('refetch'); load();
  });
  const charts = [];
  const hover = {t: null, owner: null};
  function setHover(t, owner) { hover.t = t; hover.owner = owner; charts.forEach(c => c.paintHover()); }
  function render() {
    grid.classList.remove('refetch');
    clear(grid);
    charts.length = 0;
    if (!data) return;
    for (const [key, label] of PERF_SERIES) {
      const c = lineChart({key, label, data, hover, setHover});
      charts.push(c);
      grid.append(c.el);
    }
    clear(note);
    if (data.error && !data.points.length) note.append(`No samples yet: ${data.error}`);
    else if (!data.points.length) note.append('Collecting the first samples… History is recorded every 5 seconds while the panel is running.');
    if (tableBox.open) renderTable();
  }
  function renderTable() {
    tableBox.querySelector('.table-wrap')?.remove();
    const pts = (data?.points || []).slice().reverse();
    const rows = pts.map(p => h('tr', {}, h('td', {}, new Date(p.t * 1000).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: range === '15m' ? '2-digit' : undefined})),
      PERF_SERIES.map(([k]) => h('td', {class: 'num'}, p[k] != null ? `${Math.round(p[k])}%` : '–'))));
    tableBox.append(h('div', {class: 'table-wrap perf-table-box'}, h('table', {class: 'table'},
      h('thead', {}, h('tr', {}, h('th', {}, 'Time'), PERF_SERIES.map(([, l]) => h('th', {class: 'num'}, l)))), h('tbody', {}, rows))));
  }
  async function load() {
    try { data = await PerfAPI.metrics(range); } catch (e) { grid.classList.remove('refetch'); clear(note).append(e.message); return; }
    if (ctx.alive()) render();
  }
  const onResize = debounce(() => { if (data && ctx.alive()) render(); }, 150);
  if (window.ResizeObserver) { const ro = new ResizeObserver(onResize); ro.observe(grid); ctx.onCleanup(() => ro.disconnect()); }
  else { window.addEventListener('resize', onResize); ctx.onCleanup(() => window.removeEventListener('resize', onResize)); }
  ctx.every(5000, () => { if (!hover.owner) load(); });
  load();
  return card({title: 'History', ic: 'activity', sub: 'Recorded while the panel runs; kept for 7 days on this computer'},
    h('div', {class: 'stack'}, h('div', {class: 'toolbar'}, seg), h('div', {class: 'viz'}, grid), note, tableBox));
}

function lineChart({key, label, data, hover, setHover}) {
  const W = 0, H = 132, M = {l: 38, r: 10, t: 12, b: 22};
  const wrap = h('div', {class: 'perf-chart', tabindex: '0', role: 'img'});
  const pts = data.points.filter(p => p[key] != null);
  const last = pts[pts.length - 1];
  const head = h('div', {class: 'perf-head'}, h('span', {class: 'perf-title'}, label),
    h('span', {class: 'perf-now'}, last ? `${Math.round(last[key])}%` : '–'),
    key === 'npu_mem' && last?.npu_mem_mb ? h('span', {class: 'perf-sub'}, `${(last.npu_mem_mb / 1024).toFixed(1)} of ${(last.npu_mem_total_mb / 1024).toFixed(0)} GB`) : null);
  wrap.setAttribute('aria-label', `${label} over the selected range, now ${last ? Math.round(last[key]) : 'unknown'} percent`);
  const width = Math.max(260, wrap.clientWidth || 0, W) || 420;
  const svg = svgEl('svg', {class: 'perf-svg', height: H, preserveAspectRatio: 'none'});
  const tip = h('div', {class: 'viz-tip', hidden: true});
  wrap.append(head, h('div', {class: 'perf-plot'}, svg, tip));
  const api_ = {el: wrap, paintHover};
  let x = null, plotW = 0;
  function draw() {
    const w = wrap.clientWidth || width;
    plotW = Math.max(40, w - M.l - M.r);
    svg.setAttribute('viewBox', `0 0 ${w} ${H}`);
    svg.setAttribute('width', w);
    clear(svg);
    const {start, end} = data;
    x = t => M.l + (t - start) / Math.max(1, end - start) * plotW;
    const y = v => M.t + (1 - v / 100) * (H - M.t - M.b);
    for (const v of [0, 50, 100]) {
      svg.append(svgEl('line', {x1: M.l, x2: M.l + plotW, y1: y(v), y2: y(v), class: v === 0 ? 'viz-base' : 'viz-grid'}));
      const tl = svgEl('text', {x: M.l - 6, y: y(v) + 4, class: 'viz-tick', 'text-anchor': 'end'}); tl.textContent = `${v}%`; svg.append(tl);
    }
    for (const t of timeTicks(start, end)) {
      const tl = svgEl('text', {x: x(t), y: H - 6, class: 'viz-tick', 'text-anchor': 'middle'}); tl.textContent = fmtClockTime(t, end - start); svg.append(tl);
    }
    for (const e of data.events) {
      const ex = x(e.t);
      if (ex < M.l || ex > M.l + plotW) continue;
      svg.append(svgEl('line', {x1: ex, x2: ex, y1: M.t, y2: H - M.b, class: 'viz-event'}));
      const up = e.kind === 'load';
      svg.append(svgEl('path', {d: up ? `M${ex - 4},${M.t + 1} L${ex + 4},${M.t + 1} L${ex},${M.t - 6} Z` : `M${ex - 4},${M.t - 6} L${ex + 4},${M.t - 6} L${ex},${M.t + 1} Z`, class: 'viz-event-mark'}));
    }
    // the line, broken where the panel wasn't running
    const gap = Math.max(30, data.step * 3);
    const runs = [];
    let cur = [];
    for (const p of pts) {
      if (cur.length && p.t - cur[cur.length - 1].t > gap) { runs.push(cur); cur = []; }
      cur.push(p);
    }
    if (cur.length) runs.push(cur);
    for (const run of runs) {
      const d = run.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
      if (run.length > 1) svg.append(svgEl('path', {d: `${d} L${x(run[run.length - 1].t).toFixed(1)},${y(0)} L${x(run[0].t).toFixed(1)},${y(0)} Z`, class: 'viz-area'}));
      svg.append(svgEl('path', {d, class: 'viz-line'}));
    }
    if (last) svg.append(svgEl('circle', {cx: x(last.t), cy: y(last[key]), r: 4, class: 'viz-dot'}));
    svg.append(svgEl('line', {class: 'viz-cross', y1: M.t, y2: H - M.b, x1: -10, x2: -10}));
    svg.append(svgEl('circle', {class: 'viz-focus', r: 4, cx: -10, cy: -10}));
    svg.append(svgEl('rect', {x: M.l, y: 0, width: plotW, height: H, class: 'viz-hit'}));
    paintHover();
  }
  const nearest = t => {
    let best = null;
    for (const p of data.points) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best;
  };
  function paintHover() {
    if (!x) return;
    const cross = svg.querySelector('.viz-cross'), focus = svg.querySelector('.viz-focus');
    if (hover.t == null) { cross.setAttribute('x1', -10); cross.setAttribute('x2', -10); focus.setAttribute('cx', -10); tip.hidden = true; return; }
    const p = nearest(hover.t);
    if (!p) return;
    const px = x(p.t);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px);
    const yv = p[key];
    if (yv != null) { focus.setAttribute('cx', px); focus.setAttribute('cy', M.t + (1 - yv / 100) * (H - M.t - M.b)); } else focus.setAttribute('cx', -10);
    if (hover.owner !== api_) { tip.hidden = true; return; }
    const near = data.events.filter(e => Math.abs(e.t - p.t) <= Math.max(data.step * 1.5, 8));
    append(clear(tip), [h('div', {class: 'viz-tip-time'}, new Date(p.t * 1000).toLocaleString([], {weekday: data.end - data.start > 86400 ? 'short' : undefined, hour: '2-digit', minute: '2-digit', second: data.end - data.start <= 900 ? '2-digit' : undefined})),
      PERF_SERIES.map(([k, l]) => h('div', {class: `viz-tip-row ${k === key ? 'cur' : ''}`}, h('i', {class: 'viz-key'}), h('strong', {}, p[k] != null ? `${Math.round(p[k])}%` : '–'), h('span', {}, l))),
      near.map(e => h('div', {class: 'viz-tip-ev'}, `${e.kind === 'load' ? 'Loaded' : e.kind === 'auto-unload' ? 'Unloaded (idle)' : 'Unloaded'} ${shortName(e.model)}`))]);
    tip.hidden = false;
    const tw = tip.offsetWidth || 160;
    tip.style.left = `${Math.min(Math.max(0, px + 12), (wrap.clientWidth || 300) - tw - 4)}px`;
  }
  wrap.addEventListener('pointermove', e => {
    const r = svg.getBoundingClientRect();
    const t = data.start + (e.clientX - r.left - M.l) / plotW * (data.end - data.start);
    setHover(t, api_);
  });
  wrap.addEventListener('pointerleave', () => setHover(null, null));
  wrap.addEventListener('blur', () => setHover(null, null));
  wrap.addEventListener('keydown', e => {
    if (!data.points.length) return;
    let i = hover.t == null ? data.points.length - 1 : data.points.indexOf(nearest(hover.t));
    if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
    else if (e.key === 'ArrowRight') i = Math.min(data.points.length - 1, i + 1);
    else if (e.key === 'Escape') { setHover(null, null); return; } else return;
    e.preventDefault();
    setHover(data.points[i].t, api_);
  });
  requestAnimationFrame(draw);
  draw();
  return api_;
}

/* Stable colors: a model keeps its slot while it stays loaded, whatever else loads or unloads. */
function modelSlots(ids) {
  let map = {};
  try { map = JSON.parse(localStorage.getItem('tiiny.modelSlots') || '{}'); } catch { map = {}; }
  const taken = new Set();
  const out = {};
  for (const id of ids) if (map[id] != null && !taken.has(map[id])) { out[id] = map[id]; taken.add(map[id]); }
  for (const id of ids) {
    if (out[id] != null) continue;
    let s = 0;
    while (taken.has(s) && s < SLOT_COUNT - 1) s++;
    out[id] = s; taken.add(s); map[id] = s;
  }
  try { localStorage.setItem('tiiny.modelSlots', JSON.stringify(map)); } catch { /* ignore */ }
  return out;
}

/* One bar for the whole NPU: each loaded model's share, then what is free. */
function npuPlanner({pending} = {}) {
  const ids = [...S.running].sort();
  const slots = modelSlots(ids);
  const parts = ids.map(id => ({id, share: npuShare(id)}));
  const used = parts.reduce((a, p) => a + p.share, 0);
  const wrap = h('div', {class: 'viz planner'});
  const bar = h('div', {class: 'planner-bar', role: 'img', 'aria-label': `About ${Math.round(used)}% of the NPU in use`});
  const tip = h('div', {class: 'viz-tip', hidden: true});
  for (const p of parts) {
    if (!p.share) continue;
    const seg = h('div', {class: `planner-seg s${slots[p.id] + 1}`, tabindex: '0', style: {width: `${Math.min(100, p.share)}%`}});
    const show = () => {
      clear(tip).append(h('div', {class: 'viz-tip-row cur'}, h('strong', {}, `${p.share}%`), h('span', {}, shortName(p.id))));
      tip.hidden = false;
      tip.style.left = `${Math.max(0, seg.offsetLeft)}px`;
    };
    seg.addEventListener('pointerenter', show);
    seg.addEventListener('focus', show);
    seg.addEventListener('pointerleave', () => { tip.hidden = true; });
    seg.addEventListener('blur', () => { tip.hidden = true; });
    bar.append(seg);
  }
  if (pending && !S.running.has(pending)) {
    const share = npuShare(pending);
    if (share) bar.append(h('div', {class: `planner-seg pending ${used + share > 100 ? 'over' : ''}`, style: {width: `${Math.max(0, Math.min(share, 100 - used))}%`}, title: `${shortName(pending)} would need about ${share}%`}));
  }
  const legend = h('div', {class: 'planner-legend'}, parts.map(p => h('span', {class: 'lg'}, h('i', {class: `sw s${slots[p.id] + 1}`}), h('span', {}, shortName(p.id)), h('strong', {}, p.share ? `${p.share}%` : '?'))),
    h('span', {class: 'lg free'}, h('i', {class: 'sw'}), h('span', {}, 'Free'), h('strong', {}, `${Math.max(0, Math.round(100 - used))}%`)));
  append(wrap, [h('div', {class: 'planner-head'}, h('span', {}, ids.length ? `About ${Math.round(used)}% of the NPU in use` : 'Nothing loaded: the whole NPU is free'),
    h('span', {class: 'faint small'}, 'Estimated from each model’s share')), h('div', {class: 'planner-plot'}, bar, tip), ids.length ? legend : null]);
  return wrap;
}

/* Tokens per second for each chat model, measured on your own chats. */
function speedCard(ctx) {
  const body = h('div', {}, loadingBlock());
  async function load() {
    let rows;
    try { rows = await PerfAPI.speed(); } catch (e) { clear(body).append(errorBlock(e.message)); return; }
    if (!ctx.alive()) return;
    clear(body);
    if (!rows.length) { body.append(emptyState('bolt', 'No measurements yet', 'Every chat reply is timed. Chat with a model and its speed shows up here.')); return; }
    const max = Math.max(...rows.map(r => r.tps || 0), 1);
    body.append(h('div', {class: 'table-wrap'}, h('table', {class: 'table speed-table viz'},
      h('thead', {}, h('tr', {}, h('th', {}, 'Model'), h('th', {}, 'Speed (median)'), h('th', {class: 'num'}, 'First word'), h('th', {class: 'num'}, 'Replies'))),
      h('tbody', {}, rows.map(r => h('tr', {},
        h('td', {}, h('strong', {}, shortName(r.model))),
        h('td', {}, h('div', {class: 'speed-cell'}, h('div', {class: 'speed-track'}, h('i', {style: {width: `${(r.tps || 0) / max * 100}%`}})),
          h('span', {class: 'num'}, r.tps ? `${r.tps} tok/s` : '–'))),
        h('td', {class: 'num'}, r.ttft != null ? `${r.ttft} s` : '–'),
        h('td', {class: 'num'}, String(r.runs))))))));
  }
  load();
  ctx.every(30000, load);
  return card({title: 'Speed', ic: 'bolt', sub: 'Measured on your chats: words generated per second, and the wait for the first one'}, body);
}

/* Models page: unload models nobody used for a while; pins keep favourites loaded. */
function idleCard(ctx) {
  const body = h('div', {}, loadingBlock());
  async function load() {
    let st;
    try { st = await PerfAPI.idle(); } catch (e) { clear(body).append(errorBlock(e.message)); return; }
    if (!ctx.alive()) return;
    const save = async patch => {
      try { await api('/api/settings', {method: 'POST', body: patch}); await refreshHealth(); load(); }
      catch (e) { toast('Couldn’t save', 'err', {detail: e.message}); }
    };
    const minutes = h('input', {class: 'input sm', type: 'number', min: 1, max: 1440, value: st.minutes || 30, style: {width: '90px'}});
    minutes.addEventListener('change', () => save({idle_minutes: clamp(Number(minutes.value) || 30, 1, 1440)}));
    const keep = new Set(st.keep_loaded);
    clear(body).append(h('div', {class: 'stack'},
      h('div', {class: 'row wrap gap-sm'}, switchInput(st.enabled, v => save({idle_unload: v}), 'Unload idle models'),
        h('span', {}, 'Unload models that haven’t been used for'), minutes, h('span', {}, 'minutes')),
      h('p', {class: 'small muted'}, 'Frees NPU memory automatically. A model is never unloaded while it’s answering, while the panel is working on something in the background, or when it’s pinned below.'),
      st.models.length ? h('div', {class: 'stack-sm'}, st.models.map(m => h('div', {class: 'row'},
        h('button', {type: 'button', class: `pin ${keep.has(m.id) ? 'on' : ''}`, title: keep.has(m.id) ? 'Pinned: stays loaded' : 'Pin to keep it loaded',
          onclick: () => { if (keep.has(m.id)) keep.delete(m.id); else keep.add(m.id); save({keep_loaded: [...keep]}); }}, icon('star')),
        h('strong', {class: 'spacer'}, shortName(m.id)),
        m.busy ? badge('Working', 'accent') : null,
        st.borrowed?.[m.id] ? (st.borrowed[m.id].for === 'voice'
          ? h('span', {title: 'Loaded just for 🎤 or 🔊 in a chat: it’s unloaded again afterwards'}, badge('Just for voice', '', 'mic'))
          : h('span', {title: `Loaded for ${st.borrowed[m.id].for}: it’s unloaded again after a while unused`}, badge(`For ${st.borrowed[m.id].for}`, '', 'plug'))) : null,
        h('span', {class: 'small muted'}, m.idle_seconds == null ? '' : m.idle_seconds < 60 ? 'used just now' : `idle ${fmtSecs(m.idle_seconds)}`)))) : h('p', {class: 'small muted'}, 'No models are loaded right now.'),
      st.events.length ? h('details', {class: 'small'}, h('summary', {}, `Recently unloaded (${st.events.length})`),
        h('div', {class: 'stack-sm'}, st.events.slice().reverse().map(e => h('div', {}, `${fmtAgo(e.t)}: ${shortName(e.model)}${e.detail ? ` (${e.detail})` : ''}`)))) : null));
  }
  load();
  ctx.every(30000, load);
  ctx.on('running', load);
  return card({title: 'Unload idle models', ic: 'clock'}, body);
}
