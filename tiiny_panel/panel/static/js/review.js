/* Private code review: a local model reviews a folder, ZIP or project folder for security problems and bugs. */
'use strict';

const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const SEV_KIND = {critical: 'err', high: 'err', medium: 'warn', low: 'accent', info: ''};
const ReviewAPI = {
  list: async () => (await api('/api/reviews')).reviews,
  create: body => api('/api/reviews', {method: 'POST', body}),
  get: id => api(`/api/reviews/${id}`),
  remove: id => api(`/api/reviews/${id}`, {method: 'DELETE', body: {}}),
  start: (id, body) => api(`/api/reviews/${id}/start`, {method: 'POST', body}),
  mark: (id, fid, state) => api(`/api/reviews/${id}/findings/${fid}`, {method: 'PATCH', body: {state}}),
  code: (id, path, start, end) => api(`/api/reviews/${id}/code?path=${encodeURIComponent(path)}&start=${start}&end=${end}`),
  exportUrl: (id, fmt) => `/api/reviews/${id}/export?format=${fmt}&token=${encodeURIComponent(TOKEN)}`,
};

function sevBadge(sev) { return badge(sev, SEV_KIND[sev] || ''); }

function viewReview(root, ctx) {
  if (ctx.params[0]) return viewReviewDetail(root, ctx, ctx.params[0]);
  let mode = 'folder';
  const body = h('div', {class: 'stack'});
  if (S.health?.remote) mode = 'zip';   // phones: only an uploaded ZIP (folders are on the computer)
  const seg = segmented(S.health?.remote ? [['zip', 'A ZIP file']] : [['folder', `A folder on ${hereName()}`], ['zip', 'A ZIP file'], ['project', 'A project’s folder']], mode, v => { mode = v; renderSource(); });
  const pastEl = h('div', {}, loadingBlock());
  root.append(
    h('div', {class: 'banner info'}, icon('shield'), h('div', {class: 'text'}, h('strong', {}, 'Private code review'),
      h('span', {class: 'small'}, 'Your code is reviewed by a model on your Tiiny and never leaves your network. A pattern scan for secrets and risky calls runs too. Treat the results as a careful first pass, not a guarantee.'))),
    card({title: 'Start a review', ic: 'search', sub: 'Pick what to review; you choose the files and the model next'}, h('div', {class: 'stack'}, seg, body)),
    card({title: 'Past reviews', ic: 'list'}, pastEl));

  function renderSource() {
    clear(body);
    if (mode === 'folder') {
      const path = h('input', {class: 'input mono', placeholder: '/home/you/projects/my-app', spellcheck: 'false'});
      body.append(h('div', {class: 'row wrap'}, path, btn('Browse…', async () => { const p = await folderPicker({title: 'Choose the code folder'}); if (p) path.value = p; }, {icon: 'folder'}),
        btn('Scan', () => scan({kind: 'folder', path: path.value.trim()}), {kind: 'primary', icon: 'search'})),
        h('p', {class: 'muted small'}, '.gitignore’d files and folders like node_modules, .git, venv and build output are skipped.'));
    } else if (mode === 'zip') {
      const input = h('input', {type: 'file', accept: '.zip,application/zip', hidden: true});
      const zone = h('div', {class: 'dropzone small-zone', role: 'button', tabindex: '0', onclick: () => input.click()}, icon('upload'), h('strong', {}, 'Drop a ZIP here or click to choose'));
      const go_ = async f => {
        if (!f) return;
        const dismiss = toast(`Uploading ${f.name}…`, 'info', {timeout: 600000});
        try { const up = await uploadFile(f); dismiss(); await scan({kind: 'zip', file_id: up.id}); }
        catch (e) { dismiss(); toast('Upload failed', 'err', {detail: e.message}); }
      };
      input.addEventListener('change', () => { go_(input.files[0]); input.value = ''; });
      zone.addEventListener('dragover', e => e.preventDefault());
      zone.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); go_(e.dataTransfer.files[0]); });
      S.dropHandler = files => go_(files.find(f => /\.zip$/i.test(f.name)) || files[0]);
      body.append(zone, input);
    } else {
      const sel = h('select', {class: 'input', style: {maxWidth: 'min(360px, 100%)'}}, h('option', {value: ''}, 'Loading projects…'));
      body.append(h('div', {class: 'row wrap'}, sel, btn('Scan', () => sel.value && scan({kind: 'project', project_id: sel.value}), {kind: 'primary', icon: 'search'})),
        h('p', {class: 'muted small'}, 'Uses the folder linked under the project’s Knowledge.'));
      ProjectsAPI.list().then(async ps => {
        clear(sel);
        const withFolder = [];
        for (const p of ps) { const full = await ProjectsAPI.get(p.id).catch(() => null); if (full?.docs?.some(d => d.kind === 'folder')) withFolder.push(p); }
        if (!withFolder.length) sel.append(h('option', {value: ''}, 'No project has a linked folder yet'));
        withFolder.forEach(p => sel.append(h('option', {value: p.id}, p.name)));
      });
    }
  }
  async function scan(spec) {
    if (spec.kind === 'folder' && !spec.path) { toast('Choose a folder first', 'info'); return; }
    const dismiss = toast('Scanning…', 'info', {timeout: 120000});
    try { const r = await ReviewAPI.create(spec); dismiss(); go(`review/${r.id}`); }
    catch (e) { dismiss(); toast('Couldn’t scan that', 'err', {detail: e.message}); }
  }
  async function loadPast() {
    let list;
    try { list = await ReviewAPI.list(); } catch (e) { clear(pastEl).append(errorBlock(e.message)); return; }
    if (!ctx.alive()) return;
    clear(pastEl);
    if (!list.length) { pastEl.append(h('p', {class: 'muted'}, 'No reviews yet.')); return; }
    pastEl.append(h('div', {class: 'stack-sm'}, list.map(r => h('a', {class: 'net', href: `#/review/${r.id}`}, icon('shield'),
      h('div', {class: 'spacer', style: {minWidth: 0}}, h('strong', {}, r.name), h('div', {class: 'cell-sub ellipsis'}, `${r.root} · ${r.files} file(s) · ${fmtAgo(r.updated)}`)),
      h('div', {class: 'row gap-sm'}, SEV_ORDER.filter(s => r.counts[s]).map(s => badge(`${r.counts[s]} ${s}`, SEV_KIND[s])),
        r.status !== 'done' ? badge(r.status === 'scanned' ? 'not started' : r.status, r.status === 'running' ? 'accent' : '') : null)))));
  }
  renderSource();
  loadPast();
}

function viewReviewDetail(root, ctx, rid) {
  let rec = null;
  let jobWatch = null;
  const head = h('div');
  const body = h('div', {class: 'stack'});
  root.append(head, body);
  const filters = {sev: new Set(SEV_ORDER), cat: '', q: '', showFp: false};

  async function load() {
    try { rec = await ReviewAPI.get(rid); } catch (e) { clear(body).append(errorBlock(e.message, {title: 'Review not found'})); return; }
    if (!ctx.alive()) return;
    ctx.setTitle(`Review: ${rec.name}`, rec.root);
    clear(head).append(h('div', {class: 'row wrap'}, linkBtn('All reviews', '#/review', {ic: 'rotate'}), h('span', {class: 'spacer'}),
      rec.status !== 'scanned' && rec.status !== 'running' ? h('div', {class: 'row gap-sm'},
        h('a', {class: 'btn sm', href: ReviewAPI.exportUrl(rid, 'md'), download: ''}, icon('download'), 'Markdown'),
        h('a', {class: 'btn sm', href: ReviewAPI.exportUrl(rid, 'sarif'), download: '', title: 'For GitHub code scanning and IDEs'}, icon('download'), 'SARIF'),
        h('a', {class: 'btn sm ghost', href: ReviewAPI.exportUrl(rid, 'json'), download: ''}, 'JSON')) : null,
      menuButton([
        rec.status !== 'running' && rec.status !== 'scanned' ? {label: 'Review again', icon: 'refresh', fn: () => { rec.status = 'scanned'; render(); }} : null,
        {label: 'Delete review', icon: 'trash', danger: true, fn: async () => {
          if (!(await confirmDialog({title: 'Delete this review?', message: 'The findings are deleted. Your code isn’t touched.', confirmLabel: 'Delete', danger: true}))) return;
          await ReviewAPI.remove(rid); go('review');
        }},
      ])));
    render();
    if (rec.job && !jobWatch) watch(rec.job.id);
  }

  function render() {
    clear(body);
    if (rec.status === 'scanned') return renderSetup();
    if (rec.status === 'running' || rec.job) renderProgress();
    if (rec.status === 'interrupted') body.append(h('div', {class: 'banner warn'}, icon('alert'), h('div', {class: 'text'}, h('strong', {}, 'This review was interrupted'),
      h('span', {class: 'small'}, rec.stop_reason || `${rec.files.filter(f => f.status === 'done').length} of ${rec.files.filter(f => f.selected).length} files were reviewed.`)),
      btn('Resume', () => startRun(true), {kind: 'primary', icon: 'play'})));
    const failed = rec.files.filter(f => f.selected && f.status === 'error');
    if (rec.status === 'done' && failed.length) body.append(h('div', {class: 'banner warn'}, icon('alert'), h('div', {class: 'text'},
      h('strong', {}, `${failed.length} ${failed.length === 1 ? 'file' : 'files'} couldn’t be reviewed`),
      h('span', {class: 'small'}, failed.slice(0, 3).map(f => `${f.path}: ${f.error || 'failed'}`).join(' · ') + (failed.length > 3 ? ` · and ${failed.length - 3} more` : ''))),
      btn('Try them again', () => startRun(true), {kind: 'primary', icon: 'rotate'})));
    renderResults();
  }

  function renderSetup() {
    const files = rec.files;
    const boxes = new Map();
    const est = h('div', {class: 'small muted'});
    const update = () => {
      const sel = files.filter(f => boxes.get(f.path).checked);
      const toks = sel.reduce((a, f) => a + f.tokens, 0);
      const perFile = 25;
      est.textContent = `${sel.length} of ${files.length} files · about ${toks.toLocaleString()} tokens · roughly ${fmtSecs(sel.length * perFile + toks / 300)} with an 8B model (bigger models are slower but find more)`;
    };
    const groups = new Map();
    for (const f of files) {
      const top = f.path.includes('/') ? f.path.split('/')[0] : '(top level)';
      if (!groups.has(top)) groups.set(top, []);
      groups.get(top).push(f);
    }
    const tree = h('div', {class: 'file-tree'});
    for (const [dir, list] of groups) {
      const dirBox = h('input', {type: 'checkbox'});
      const rows = list.map(f => {
        const c = h('input', {type: 'checkbox', checked: f.selected, onchange: () => { syncDir(); update(); }});
        boxes.set(f.path, c);
        return h('label', {class: 'check file-row'}, c, h('span', {class: 'mono small spacer ellipsis', title: f.path}, f.path), h('span', {class: 'faint small'}, `${f.lang} · ${fmtBytes(f.size)}`));
      });
      const syncDir = () => { const n = list.filter(f => boxes.get(f.path).checked).length; dirBox.checked = n === list.length; dirBox.indeterminate = n > 0 && n < list.length; };
      dirBox.addEventListener('change', () => { list.forEach(f => { boxes.get(f.path).checked = dirBox.checked; }); syncDir(); update(); });
      syncDir();
      tree.append(h('details', {class: 'dir', open: groups.size < 6}, h('summary', {}, dirBox, icon('folder'), h('strong', {}, dir), h('span', {class: 'faint small'}, `${list.length} file(s)`)), rows));
    }
    const chatModelsList = modelsOf('chat').sort((a, b) => (parseFloat(b.params) || 0) - (parseFloat(a.params) || 0));
    const fitsList = chatModelsList.filter(m => S.running.has(m.id) || fitCheck(m.id).fits);
    const preferred = chatModelsList.find(m => S.running.has(m.id)) || fitsList[0] || chatModelsList[0];
    const modelSel = h('select', {class: 'input'}, chatModelsList.map(m => h('option', {value: m.id, selected: m === preferred},
      `${S.running.has(m.id) ? '● ' : ''}${m.display_name || m.name} (${m.params || '?'}${m.npu_usage ? `, ${m.npu_usage}% NPU` : ''})`)));
    let focus = 'security';
    const focusSeg = segmented([['security', 'Security'], ['bugs', 'Bugs'], ['all', 'Both']], focus, v => { focus = v; });
    const thinkChk = h('input', {type: 'checkbox'});
    const extra = h('textarea', {class: 'input', rows: 3, placeholder: 'Optional, e.g. “This is a public API; all input is untrusted. We use PostgreSQL through psycopg.”'});
    const quick = (label, fn) => btn(label, () => { files.forEach(f => { boxes.get(f.path).checked = fn(f); }); tree.querySelectorAll('details').forEach(dd => dd.querySelector('summary input').dispatchEvent(new Event('sync'))); render_(); }, {small: true, kind: 'ghost'});
    const render_ = () => { for (const dd of tree.querySelectorAll('details')) { const ins = [...dd.querySelectorAll('.file-row input')]; const n = ins.filter(i => i.checked).length; const db = dd.querySelector('summary input'); db.checked = n === ins.length; db.indeterminate = n > 0 && n < ins.length; } update(); };
    body.append(
      card({title: 'Files', ic: 'file', sub: `${rec.root}${rec.truncated ? ' (first 3,000 files)' : ''}`, actions: [
        quick('Code only', f => !/(^|\/)(tests?|__tests__|spec)\/|(_test|\.test|\.spec)\./.test(f.path) && f.selected !== undefined && /Python|Script|Go|Rust|Java|Kotlin|Ruby|PHP|C|Swift|Shell|SQL|HTML|Vue|Svelte|Terraform|Dockerfile|YAML|Scala|Lua|Perl|Elixir|Dart|Solidity/.test(f.lang)),
        quick('Everything', () => true), quick('None', () => false)]},
        h('div', {class: 'stack'}, tree, est,
          Object.keys(rec.skipped || {}).length ? h('p', {class: 'faint small'}, `Skipped: ${Object.entries(rec.skipped).map(([k, v]) => `${v} ${k}`).join(', ')}`) : null)),
      card({title: 'How to review', ic: 'settings'}, h('div', {class: 'form'},
        h('div', {class: 'form-row'}, h('div', {class: 'field'}, h('label', {}, 'Model'), modelSel, h('small', {class: 'hint'}, 'Bigger models catch more; smaller ones are faster.')),
          h('div', {class: 'field'}, h('label', {}, 'Look for'), focusSeg)),
        h('label', {class: 'check'}, thinkChk, h('span', {}, h('span', {}, 'Let the model think before answering'), h('small', {class: 'muted'}, 'Sometimes more thorough, but several times slower.'))),
        h('div', {class: 'field'}, h('label', {}, 'Context for the reviewer'), extra),
        h('div', {}, btn('Start review', async () => {
          const chosen = files.filter(f => boxes.get(f.path).checked).map(f => f.path);
          if (!chosen.length) { toast('Select at least one file', 'info'); return; }
          if (!(await loadModel(modelSel.value, {quiet: true}))) return;
          rec.pendingOptions = {files: chosen, model: modelSel.value, focus, thinking: thinkChk.checked, extra: extra.value};
          await startRun(false);
        }, {kind: 'primary', icon: 'play'})))));
    update();
    if (!S.modelsAt) refreshModels().then(() => { if (ctx.alive() && rec.status === 'scanned') render(); });
  }

  async function startRun(resume) {
    const opts = resume ? {...(rec.options || {}), resume: true} : rec.pendingOptions;
    if (resume && !(await loadModel(opts.model, {quiet: true}))) return;
    try {
      const job = await ReviewAPI.start(rid, opts);
      rec.status = 'running';
      watch(job.id);
      await load();
    } catch (e) { toast('Couldn’t start the review', 'err', {detail: e.message}); }
  }

  /* The progress card: how far along, the current step, what the model is writing (job.live, streamed by the panel
     while it reviews), and what it did so far. Built once and updated in place, so the text box keeps its scroll. */
  let progressEl = null, prog = null;
  function renderProgress() {
    progressEl = h('div', {class: 'stack-sm review-progress'});
    const text = h('pre', {class: 'review-live-text', 'aria-live': 'off'});
    const box = h('details', {class: 'review-live', open: !window.matchMedia?.('(max-width: 600px)').matches},
      h('summary', {}, 'What it’s writing'), text);
    prog = {now: h('span', {class: 'spacer'}), eta: h('span', {class: 'faint'}), bar: h('div'), where: h('span'), elapsed: h('span', {class: 'faint'}),
      box, text, log: h('ul', {class: 'review-log'}), follow: true};
    text.addEventListener('scroll', () => { prog.follow = text.scrollTop + text.clientHeight >= text.scrollHeight - 24; });
    progressEl.append(h('div', {class: 'row small'}, h('span', {class: 'spinner'}), prog.now, prog.eta), prog.bar,
      h('div', {class: 'row small muted wrap gap-sm'}, prog.where, prog.elapsed), box,
      h('div', {class: 'stack-sm'}, h('strong', {class: 'small'}, 'So far'), prog.log));
    body.append(card({title: 'Reviewing…', ic: 'activity', actions: [btn('Cancel', async () => { if (rec.job) await api(`/api/jobs/${rec.job.id}/cancel`, {method: 'POST', body: {}}); }, {small: true, kind: 'ghost', icon: 'x'})]}, progressEl));
    paintProgress(rec.job);
  }
  function paintProgress(j) {
    if (!progressEl || !prog || !j) return;
    const live = j.live || {}, eta = j.meta?.eta;
    prog.now.textContent = j.message || 'Starting…';
    prog.eta.textContent = eta ? `about ${fmtSecs(eta)} left` : '';
    clear(prog.bar).append(progressBar((j.progress ?? 0) * 100, {indeterminate: j.progress == null}));
    prog.where.textContent = live.file_n ? `File ${live.file_n} of ${live.files}${live.parts > 1 ? ` · part ${live.part} of ${live.parts}` : ''}`
      : live.phase === 'checking' ? `Checking the findings in ${live.file}` : live.phase === 'summary' ? 'Writing the summary' : '';
    prog.elapsed.textContent = j.created ? `${fmtSecs(Math.max(0, Date.now() / 1000 - j.created))} so far` : '';
    const text = live.text || (live.phase === 'checking' ? 'A decision model is checking each finding…' : live.file ? 'Waiting for the model to start answering…' : '');
    if (prog.text.textContent !== text) {
      prog.text.textContent = text;
      if (prog.follow) prog.text.scrollTop = prog.text.scrollHeight;
    }
    const lines = (live.log || []).map(l => l.replace(/^\d\d:\d\d:\d\d\s+/, '').trim()).filter(Boolean);
    clear(prog.log).append(...(lines.length ? lines : ['Starting…']).slice(-6).map(l => h('li', {}, l)));
  }
  function watch(jid) {
    jobWatch = jid;
    let lastLoad = 0;
    followJob(jid, j => {
      if (rec) rec.job = j;
      paintProgress(j);
      if (Date.now() - lastLoad > 4000) { lastLoad = Date.now(); ReviewAPI.get(rid).then(r => { if (ctx.alive() && r.status === 'running') { rec = r; refreshResults(); } }).catch(() => {}); }
    }).then(j => {
      jobWatch = null;
      if (j.status === 'failed') toast('The review failed', 'err', {detail: j.error});
      else if (j.status === 'done') { toast('Review finished', 'ok', {detail: j.message}); notify('Code review finished', `${rec?.name}: ${j.message}`); }
      if (ctx.alive()) load();
    });
  }

  let resultsEl = null;
  function renderResults() {
    resultsEl = h('div', {class: 'stack'});
    body.append(resultsEl);
    refreshResults();
  }
  function refreshResults() {
    if (!resultsEl) return;
    clear(resultsEl);
    const all = rec.findings || [];
    const counts = Object.fromEntries(SEV_ORDER.map(s => [s, all.filter(f => f.severity === s && f.state !== 'false_positive').length]));
    if (rec.summary) resultsEl.append(card({title: 'Summary', ic: 'info', sub: rec.stats?.seconds ? `${rec.files.filter(f => f.selected).length} files in ${fmtSecs(rec.stats.seconds)} with ${shortName(rec.options?.model || '')}` : ''},
      h('div', {class: 'md', html: renderMarkdown(rec.summary)})));
    if (!all.length) {
      if (rec.status === 'done') resultsEl.append(card({}, emptyState('check', 'No problems found', 'Nothing was flagged in the reviewed files. A local model can miss things; consider a bigger model or the “Both” focus.')));
      return;
    }
    const cats = [...new Set(all.map(f => f.category))].sort();
    const catSel = h('select', {class: 'input sm', style: {width: 'auto'}, onchange: e => { filters.cat = e.target.value; refreshResults(); }},
      h('option', {value: ''}, 'All categories'), cats.map(c => h('option', {value: c, selected: c === filters.cat}, c)));
    const chips = SEV_ORDER.filter(s => counts[s] || all.some(f => f.severity === s)).map(s => h('button', {type: 'button', class: `chip ${filters.sev.has(s) ? 'active' : ''}`,
      onclick: () => { if (filters.sev.has(s)) filters.sev.delete(s); else filters.sev.add(s); refreshResults(); }}, s, h('span', {class: 'n'}, String(counts[s]))));
    const fpChk = h('input', {type: 'checkbox', checked: filters.showFp, onchange: e => { filters.showFp = e.target.checked; refreshResults(); }});
    // A decision model's check (f.likely, 0..1): unlikely ones can be hidden; likely ones come first within a severity.
    const checked = all.some(f => typeof f.likely === 'number');
    const unlikely = f => typeof f.likely === 'number' && f.likely < 0.3;
    const nUnlikely = all.filter(unlikely).length;
    const hideChk = h('input', {type: 'checkbox', checked: !!filters.hideUnlikely, onchange: e => { filters.hideUnlikely = e.target.checked; refreshResults(); }});
    const rows = all.filter(f => filters.sev.has(f.severity) && (!filters.cat || f.category === filters.cat) && (filters.showFp || f.state !== 'false_positive')
      && !(filters.hideUnlikely && unlikely(f)) && (!filters.q || `${f.title} ${f.path} ${f.explanation}`.toLowerCase().includes(filters.q)))
      .sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || (b.likely ?? 0.5) - (a.likely ?? 0.5) || a.path.localeCompare(b.path) || a.line_start - b.line_start);
    const search = searchBox('Filter findings…', v => { filters.q = v.toLowerCase(); refreshResults(); }, filters.q);
    resultsEl.append(card({title: `Findings (${rows.length})`, ic: 'shield'}, h('div', {class: 'stack'},
      h('div', {class: 'toolbar'}, h('div', {class: 'row wrap gap-sm'}, chips), catSel, search, h('label', {class: 'check small'}, fpChk, h('span', {}, 'Show false positives')),
        checked ? h('label', {class: 'check small', title: 'Findings a decision model thinks are unlikely to be real problems (under 30%)'}, hideChk, h('span', {}, `Hide unlikely (${nUnlikely})`)) : null),
      rows.length ? h('div', {class: 'stack-sm'}, rows.map(findingCard)) : h('p', {class: 'muted'}, 'No findings match the filters.'))));
  }

  function findingCard(f) {
    const codeEl = h('div');
    let shown = false;
    const showCode = async () => {
      if (shown) { clear(codeEl); shown = false; return; }
      shown = true;
      clear(codeEl).append(loadingBlock());
      try {
        const c = await ReviewAPI.code(rid, f.path, Math.max(1, f.line_start - 4), f.line_end + 4);
        const w = String(c.end).length;
        clear(codeEl).append(h('pre', {class: 'code-excerpt'}, c.lines.map((l, i) => {
          const n = c.start + i;
          return h('div', {class: n >= f.line_start && n <= f.line_end ? 'hl' : ''}, h('span', {class: 'ln'}, String(n).padStart(w)), ' ', l);
        })));
      } catch (e) { clear(codeEl).append(h('p', {class: 'muted small'}, e.message)); }
    };
    const mark = async state => { await ReviewAPI.mark(rid, f.id, state); f.state = state; refreshResults(); };
    return h('div', {class: `finding sev-${f.severity} ${f.state === 'false_positive' ? 'fp' : ''}`},
      h('div', {class: 'finding-head'}, sevBadge(f.severity), h('strong', {class: 'spacer'}, f.title),
        f.source === 'pattern' ? badge('pattern', '', 'search') : badge(`AI · ${f.confidence}`),
        typeof f.likely === 'number' ? h('span', {title: 'How likely a decision model thinks this is a real problem'},
          badge(`Likely real ${Math.round(f.likely * 100)}%`, f.likely >= 0.7 ? 'ok' : f.likely < 0.3 ? 'warn' : '')) : null,
        f.state && f.state !== 'open' ? badge(f.state.replace('_', ' '), f.state === 'fixed' ? 'ok' : '') : null),
      h('div', {class: 'row wrap gap-sm small'}, h('button', {class: 'link-btn mono', type: 'button', onclick: showCode}, `${f.path}:${f.line_start}${f.line_end > f.line_start ? `–${f.line_end}` : ''}`),
        h('span', {class: 'faint'}, f.category)),
      codeEl,
      f.explanation ? h('p', {class: 'small'}, f.explanation) : null,
      f.suggestion ? h('div', {class: 'md small fix'}, h('strong', {}, 'Fix: '), h('span', {html: renderMarkdown(f.suggestion)})) : null,
      h('div', {class: 'row wrap gap-sm'},
        f.state === 'false_positive' || f.state === 'fixed' ? btn('Reopen', () => mark('open'), {small: true, kind: 'ghost'})
          : [btn('False positive', () => mark('false_positive'), {small: true, kind: 'ghost', icon: 'x'}), btn('Fixed', () => mark('fixed'), {small: true, kind: 'ghost', icon: 'check'})],
        btn('Ask in chat', async () => {
          const c = await ReviewAPI.code(rid, f.path, Math.max(1, f.line_start - 15), f.line_end + 15).catch(() => null);
          ChatUI.preset = rec.options?.model || null;
          ChatUI.draft = `In \`${f.path}\` (lines ${f.line_start}–${f.line_end}) a review flagged: **${f.title}** (${f.severity}, ${f.category}).\n\n${f.explanation}\n\n` +
            (c ? `\`\`\`\n${c.lines.join('\n')}\n\`\`\`\n\n` : '') + 'Is this a real problem? If so, show me a fixed version.';
          go('chat');
        }, {small: true, kind: 'ghost', icon: 'chat'})));
  }

  load();
}

registerView({id: 'review', order: 58, group: 'create', title: 'Code review', ic: 'shield', sub: 'Find security problems and bugs with a model on your device', render: viewReview});
