/* Projects: spaces whose chats share instructions, knowledge (files, web pages, a folder) and memory. */
'use strict';

const KIND_ICON = {file: 'file', web: 'link', note: 'edit', vault: 'archive', folder: 'folder'};
const KIND_LABEL = {file: 'File', web: 'Web page', note: 'Note', vault: 'From Vault', folder: 'Linked folder'};
const CONTEXT_LABEL = {small: 'Small (~3k tokens, fastest)', medium: 'Medium (~6k tokens)', large: 'Large (~12k tokens, slower answers)'};

/* Pick a folder on this computer. Resolves the chosen path, or null. */
function folderPicker({title = 'Choose a folder', start = ''} = {}) {
  return new Promise(resolve => {
    let done = false;
    let current = start;
    const list = h('div', {class: 'fs-list'});
    const pathInput = h('input', {class: 'input mono', value: start, 'aria-label': 'Folder path', spellcheck: 'false'});
    const info = h('div', {class: 'faint small'});
    async function open(path) {
      clear(list).append(loadingBlock());
      try {
        const r = await api(`/api/fs/list?path=${encodeURIComponent(path || '')}`);
        current = r.path;
        pathInput.value = r.path;
        clear(list);
        if (r.parent) list.append(h('button', {class: 'fs-item', type: 'button', onclick: () => open(r.parent)}, icon('rotate'), h('span', {}, '.. (up one level)')));
        const dirs = r.entries.filter(e => e.dir);
        for (const e of dirs) list.append(h('button', {class: 'fs-item', type: 'button', onclick: () => open(`${r.path.replace(/\/$/, '')}/${e.name}`)}, icon('folder'), h('span', {}, e.name)));
        if (!dirs.length) list.append(h('p', {class: 'muted small', style: {padding: '8px 10px'}}, 'No sub-folders.'));
        info.textContent = `${dirs.length} folder(s) and ${r.entries.length - dirs.length} file(s) here`;
      } catch (e) { clear(list).append(errorBlock(e.message, {title: 'Can’t open that folder'})); }
    }
    pathInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); open(pathInput.value.trim()); } });
    const md = modal({title, size: 'wide', onClose: () => { if (!done) resolve(null); },
      body: h('div', {class: 'stack'}, h('div', {class: 'row'}, pathInput, btn('Go', () => open(pathInput.value.trim()), {small: true})), list, info),
      actions: [h('button', {class: 'btn ghost', type: 'button', onclick: () => md.close()}, 'Cancel'),
        h('button', {class: 'btn primary', type: 'button', onclick: () => { done = true; md.close(); resolve(current); }}, 'Use this folder')]});
    open(start);
  });
}

/* Pick files that are already in the Vault. Resolves [{source_id, filename}] or null. */
function vaultPicker() {
  return new Promise(resolve => {
    let done = false;
    const list = h('div', {class: 'stack-sm'}, loadingBlock('Loading your Vault…'));
    const picked = new Map();
    const md = modal({title: 'Add files from your Vault', size: 'wide', onClose: () => { if (!done) resolve(null); }, body: list,
      actions: [h('button', {class: 'btn ghost', type: 'button', onclick: () => md.close()}, 'Cancel'),
        h('button', {class: 'btn primary', type: 'button', onclick: () => { done = true; md.close(); resolve([...picked.values()]); }}, 'Add selected')]});
    dev('/kb/sources', {service: 'kb', query: {limit: 500}, quiet: true, silent: true}).then(r => {
      clear(list);
      const items = (r.json?.items || []).filter(x => !/conversation/i.test(x.source_type || ''));
      if (!r.ok) { list.append(errorBlock(r.error, {title: 'Couldn’t open the Vault'})); return; }
      if (!items.length) { list.append(emptyState('folder', 'No files in your Vault', 'Add files on the Vault page, or add them here directly.')); return; }
      for (const x of items) {
        const c = h('input', {type: 'checkbox', onchange: () => { if (c.checked) picked.set(x.source_id, {source_id: x.source_id, filename: x.filename}); else picked.delete(x.source_id); }});
        list.append(h('label', {class: 'check'}, c, h('span', {}, h('span', {}, x.filename), h('small', {class: 'muted'}, `${x.size_human || fmtBytes(x.size_bytes)} · added ${fmtAgo(x.created_at)}`))));
      }
    });
  });
}

async function viewProjectDoc(pid, did, name) {
  const body = h('div', {}, loadingBlock());
  modal({title: name || 'File', size: 'xwide', body});
  try {
    const r = await ProjectsAPI.doc(pid, did);
    clear(body).append(h('div', {class: 'stack-sm'},
      h('div', {class: 'row'}, badge(KIND_LABEL[r.doc.kind] || r.doc.kind), safeUrl(r.doc.url) ? h('a', {href: safeUrl(r.doc.url), target: '_blank', rel: 'noopener noreferrer', class: 'small'}, r.doc.url) : null,
        h('span', {class: 'spacer'}), h('span', {class: 'faint small'}, `${(r.doc.tokens || 0).toLocaleString()} tokens`)),
      h('pre', {class: 'out-box doc-text'}, r.text), r.truncated ? h('p', {class: 'muted small'}, 'Showing the beginning only.') : null));
  } catch (e) { clear(body).append(errorBlock(e.message)); }
}

/* Lists and edits the knowledge of a project (also used for a chat's pinned files). */
function KnowledgeManager(el, pid, {compact = false, onChange} = {}) {
  let project = null;
  let job = null;
  const statusEl = h('div');
  const listEl = h('div', {}, loadingBlock());
  const fileInput = h('input', {type: 'file', multiple: true, hidden: true});
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
  const dropzone = h('div', {class: 'dropzone small-zone', role: 'button', tabindex: '0', onclick: () => fileInput.click()},
    icon('upload'), h('strong', {}, 'Drop files here or click to add'),
    h('span', {class: 'muted small'}, 'PDF, Word, PowerPoint, Excel, ePub, HTML, Markdown, text and code files'));
  for (const ev of ['dragover', 'dragenter']) dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
  append(el, [h('div', {class: 'stack'},
    h('div', {class: 'row wrap'},
      btn('Web page', addUrl, {small: true, icon: 'link'}),
      btn('From Vault', addFromVault, {small: true, icon: 'archive'}),
      btn('Note', addNote, {small: true, icon: 'edit'}),
      compact || S.health?.remote ? null : btn('Link a folder', addFolder, {small: true, icon: 'folder'})),
    dropzone, statusEl, listEl, fileInput)]);

  async function load() {
    try { project = await ProjectsAPI.get(pid); } catch (e) { clear(listEl).append(errorBlock(e.message)); return; }
    render();
    if (project.index_job && !job) watch(project.index_job.id);
    if (onChange) onChange(project);
  }

  function renderStatus() {
    clear(statusEl);
    if (!project) return;
    const st = project.index_state || {};
    const docs = project.docs || [];
    if (!docs.length) return;
    if (job && job.status === 'running') {
      statusEl.append(h('div', {class: 'stack-sm'}, h('div', {class: 'row small'}, h('span', {class: 'spinner'}), h('span', {}, job.message || 'Indexing…')), progressBar((job.progress ?? 0) * 100, {indeterminate: job.progress == null})));
      return;
    }
    if (!st.needed) {
      statusEl.append(h('div', {class: 'banner info'}, icon('info'), h('div', {class: 'text'},
        h('strong', {}, `${st.tokens.toLocaleString()} tokens: small enough to read in full`),
        h('span', {class: 'small'}, 'Every answer sees all of these files, no index needed.'))));
      return;
    }
    if (st.stale > 0 || !st.chunks) {
      statusEl.append(h('div', {class: 'banner warn'}, icon('alert'), h('div', {class: 'text'},
        h('strong', {}, st.chunks ? `${st.stale} file(s) changed since the last index` : 'These files need an index so chat can search them'),
        h('span', {class: 'small'}, 'Indexing uses the embedding model on your device. It usually takes a few seconds per file.')),
        btn('Index now', startIndex, {small: true, kind: 'primary', icon: 'bolt'})));
      return;
    }
    statusEl.append(h('div', {class: 'banner info'}, icon('check'), h('div', {class: 'text'},
      h('strong', {}, `Indexed: ${st.chunks.toLocaleString()} passages from ${st.sources} file(s)`),
      h('span', {class: 'small'}, `Each question gets the most relevant passages${st.indexed_at ? ` · updated ${fmtAgo(st.indexed_at)}` : ''}.`)),
      btn('Re-index', startIndex, {small: true, kind: 'ghost', icon: 'refresh'})));
  }

  function render() {
    renderStatus();
    clear(listEl);
    const docs = (project.docs || []).slice().sort((a, b) => (b.added || 0) - (a.added || 0));
    if (!docs.length) {
      listEl.append(emptyState('file', 'No files yet', compact ? 'Add files this chat should know about.' : 'Add the documents, notes, web pages or code folder this project is about.'));
      return;
    }
    listEl.append(h('div', {class: 'table-wrap'}, h('table', {class: 'table'}, h('tbody', {}, docs.map(d => h('tr', {},
      h('td', {}, h('div', {class: 'row gap-sm'}, icon(KIND_ICON[d.kind] || 'file'), h('div', {style: {minWidth: 0}},
        h('div', {class: 'cell-title ellipsis', title: d.name}, d.name),
        h('div', {class: 'cell-sub ellipsis'}, d.kind === 'folder' ? `${d.path} · ${d.files} files${d.truncated ? ' (first 5,000)' : ''}` : d.url || KIND_LABEL[d.kind] || d.kind)))),
      h('td', {class: 'nowrap small muted'}, `${(d.tokens || 0).toLocaleString()} tokens`),
      h('td', {class: 'nowrap small muted'}, fmtAgo(d.added)),
      h('td', {class: 'actions-col'}, h('div', {class: 'row-actions'},
        iconBtn('eye', 'View', () => viewProjectDoc(pid, d.id, d.name)),
        iconBtn('trash', 'Remove', async () => {
          if (!(await confirmDialog({title: `Remove ${d.name}?`, message: d.kind === 'folder' ? 'The folder stays on your computer; it’s just unlinked.' : 'It’s removed from here (not from your Vault or your computer).', confirmLabel: 'Remove', danger: true}))) return;
          await ProjectsAPI.removeDoc(pid, d.id);
          await afterChange(false);
        })))))))));
  }

  async function afterChange(autoIndex = true) {
    await load();
    const st = project?.index_state || {};
    if (autoIndex && st.needed && st.stale > 0 && !job) startIndex();
  }
  async function startIndex() {
    try { const j = await ProjectsAPI.index(pid); watch(j.id); }
    catch (e) { toast('Couldn’t start indexing', 'err', {detail: e.message}); }
  }
  function watch(jid) {
    job = {id: jid, status: 'running'};
    renderStatus();
    followJob(jid, j => { job = j; renderStatus(); }).then(async j => {
      job = null;
      if (j.status === 'failed') toast('Indexing failed', 'err', {detail: j.error});
      else if (j.status === 'done' && j.result?.updated) toast(`Indexed ${j.result.updated} file(s)`, 'ok');
      await load();
    });
  }
  async function addFiles(files) {
    for (const f of files) {
      const dismiss = toast(`Reading ${f.name}…`, 'info', {timeout: 600000});
      try {
        const up = await uploadFile(f);
        await ProjectsAPI.addDoc(pid, {kind: 'upload', file_id: up.id});
        dismiss();
        toast(`Added ${f.name}`, 'ok');
      } catch (e) {
        dismiss();
        toast(`Couldn’t add ${f.name}`, 'err', {detail: e.message});
      }
    }
    await afterChange();
  }
  async function addUrl() {
    const v = await formDialog({title: 'Add a web page', submitLabel: 'Add', fields: [{name: 'url', label: 'Address', placeholder: 'https://…', required: true}]});
    if (!v) return;
    const dismiss = toast('Reading the page…', 'info', {timeout: 120000});
    try { const d = await ProjectsAPI.addDoc(pid, {kind: 'url', url: v.url}); dismiss(); toast(`Added “${d.name}”`, 'ok'); }
    catch (e) { dismiss(); toast('Couldn’t add the page', 'err', {detail: e.message}); }
    await afterChange();
  }
  async function addNote() {
    const v = await formDialog({title: 'Add a note', size: 'wide', submitLabel: 'Add', fields: [
      {name: 'title', label: 'Title', required: true, maxlength: 160},
      {name: 'text', label: 'Text', type: 'textarea', rows: 10, required: true, placeholder: 'Requirements, decisions, background… anything chats in this project should know.'}]});
    if (!v) return;
    try { await ProjectsAPI.addDoc(pid, {kind: 'note', title: v.title, text: v.text}); toast('Note added', 'ok'); }
    catch (e) { toast('Couldn’t add the note', 'err', {detail: e.message}); }
    await afterChange();
  }
  async function addFromVault() {
    const items = await vaultPicker();
    if (!items || !items.length) return;
    for (const it of items) {
      const dismiss = toast(`Copying ${it.filename} from the Vault…`, 'info', {timeout: 300000});
      try { await ProjectsAPI.addDoc(pid, {kind: 'vault', ...it}); dismiss(); }
      catch (e) { dismiss(); toast(`Couldn’t add ${it.filename}`, 'err', {detail: e.message}); }
    }
    await afterChange();
  }
  async function addFolder() {
    const path = await folderPicker({title: 'Link a folder to this project'});
    if (!path) return;
    const v = await formDialog({title: 'Link this folder?', submitLabel: 'Link folder',
      intro: h('div', {class: 'stack-sm'}, h('p', {}, h('code', {}, path)),
        h('p', {class: 'muted small'}, 'Text and code files are read straight from disk and re-indexed when they change. Binary files, .gitignore’d files and folders like node_modules, .git and venv are skipped.')),
      fields: [{name: 'include', label: 'Only these files (optional)', placeholder: '*.py, src/*', hint: 'Comma-separated patterns. Empty means everything.'},
        {name: 'exclude', label: 'Also skip (optional)', placeholder: 'tests/*, *.csv'}]});
    if (!v) return;
    const split = s => s.split(',').map(x => x.trim()).filter(Boolean);
    const dismiss = toast('Scanning the folder…', 'info', {timeout: 120000});
    try { const d = await ProjectsAPI.addDoc(pid, {kind: 'folder', path, include: split(v.include), exclude: split(v.exclude)}); dismiss(); toast(`Linked ${d.files} file(s)`, 'ok'); }
    catch (e) { dismiss(); toast('Couldn’t link the folder', 'err', {detail: e.message}); }
    await afterChange();
  }
  load();
  return {load, addFiles, get project() { return project; }};
}

async function newProjectDialog() {
  const v = await formDialog({title: 'New project', submitLabel: 'Create project', size: 'wide',
    intro: 'A project keeps related chats together. They all share its instructions, files and memory.',
    fields: [
      {name: 'name', label: 'Name', required: true, maxlength: 120, placeholder: 'Thesis, Home lab, Payments service…'},
      {name: 'description', label: 'Description (optional)', maxlength: 2000},
      {name: 'instructions', label: 'Instructions (optional)', type: 'textarea', rows: 5,
        placeholder: 'How should the model behave in this project? e.g. “You are reviewing my Go payments service. Prefer concrete code. Be blunt about security problems.”'},
    ]});
  if (!v) return null;
  const p = await ProjectsAPI.create(v);
  toast(`Created “${p.name}”`, 'ok');
  return p;
}

function viewProjects(root, ctx) {
  if (ctx.params[0]) return viewProject(root, ctx, ctx.params[0]);
  let query = '';
  const grid = h('div', {}, loadingBlock());
  root.append(
    h('div', {class: 'toolbar'}, searchBox('Find a project…', v => { query = v.toLowerCase(); render(); }), h('span', {class: 'spacer'}),
      btn('New project', async () => { const p = await newProjectDialog(); if (p) go(`projects/${p.id}`); }, {kind: 'primary', icon: 'plus'})),
    grid);
  let projects = null;
  let counts = {};
  async function load() {
    try {
      const [ps, chats] = await Promise.all([ProjectsAPI.list(), Store.list('chats', ['id', 'project_id'])]);
      projects = ps;
      counts = {};
      for (const c of chats) if (c.project_id) counts[c.project_id] = (counts[c.project_id] || 0) + 1;
    } catch (e) { clear(grid).append(errorBlock(e.message, {retry: load})); return; }
    if (ctx.alive()) render();
  }
  function render() {
    clear(grid);
    if (!projects.length) {
      grid.append(card({}, emptyState('folder', 'No projects yet',
        'Create a project for anything you work on over many chats: it keeps instructions, files, a code folder and what you’ve decided so far, and every chat in it starts with that context.',
        btn('Create your first project', async () => { const p = await newProjectDialog(); if (p) go(`projects/${p.id}`); }, {kind: 'primary', icon: 'plus'}))));
      return;
    }
    const rows = projects.filter(p => !query || `${p.name} ${p.description}`.toLowerCase().includes(query));
    grid.append(h('div', {class: 'model-grid'}, rows.map(p => h('a', {class: 'model-card project-card', href: `#/projects/${p.id}`},
      h('div', {class: 'model-head'}, h('div', {class: 'model-icon', style: {color: 'var(--accent)'}}, icon('folder')),
        h('div', {class: 'model-title'}, h('strong', {}, p.name), h('span', {class: 'faint small'}, `Updated ${fmtAgo(p.updated)}`))),
      p.description ? h('div', {class: 'model-desc'}, p.description) : null,
      h('div', {class: 'model-stats'},
        h('span', {}, h('b', {}, String(counts[p.id] || 0)), ' chats'),
        h('span', {}, h('b', {}, String(p.docs)), ' files'),
        h('span', {}, h('b', {}, String(p.memory)), ' remembered'),
        p.model ? h('span', {}, shortName(p.model)) : null)))));
  }
  load();
}

function viewProject(root, ctx, pid) {
  let project = null;
  let tab = sessionStorage.getItem(`tiiny.projectTab.${pid}`) || 'chats';
  const head = h('div');
  const body = h('div');
  const seg = segmented([['chats', 'Chats'], ['knowledge', 'Knowledge'], ['instructions', 'Instructions'], ['memory', 'Memory'], ['settings', 'Settings']], tab,
    t => { tab = t; sessionStorage.setItem(`tiiny.projectTab.${pid}`, t); renderTab(); });
  root.append(head, h('div', {class: 'toolbar'}, seg), body);

  async function load() {
    try { project = await ProjectsAPI.get(pid); } catch (e) { clear(head).append(errorBlock(e.message, {title: 'Project not found'})); return; }
    if (!ctx.alive()) return;
    ctx.setTitle(project.name, project.description || 'Project');
    clear(head).append(h('div', {class: 'row wrap'}, linkBtn('All projects', '#/projects', {ic: 'rotate'}), h('span', {class: 'spacer'}),
      btn('New chat in this project', newChat, {kind: 'primary', icon: 'chat'})));
    renderTab();
  }
  async function newChat() {
    ChatUI.scope = pid;
    go(`chat?project=${pid}`);
  }

  function renderTab() {
    clear(body);
    S.dropHandler = null;
    if (tab === 'chats') return renderChats();
    if (tab === 'knowledge') {
      const holder = h('div');
      body.append(card({title: 'Knowledge', ic: 'file', sub: 'Every chat in this project can use these. Answers cite the passages they use.'}, holder));
      const km = KnowledgeManager(holder, pid, {onChange: p => { project = {...project, ...p}; }});
      S.dropHandler = files => km.addFiles(files);
      return;
    }
    if (tab === 'instructions') return renderInstructions();
    if (tab === 'memory') return renderMemory();
    return renderSettings();
  }

  async function renderChats() {
    const list = h('div', {}, loadingBlock());
    body.append(card({title: 'Chats', ic: 'chat', actions: [btn('New chat', newChat, {small: true, kind: 'primary', icon: 'plus'})]}, list));
    const chats = await Store.list('chats', ['id', 'title', 'updated'], {project_id: pid}).catch(() => []);
    clear(list);
    if (!chats.length) { list.append(emptyState('chat', 'No chats yet', 'Start one: it gets this project’s instructions, files and memory automatically.', btn('Start a chat', newChat, {kind: 'primary'}))); return; }
    list.append(h('div', {class: 'stack-sm'}, chats.map(c => h('a', {class: 'net', href: `#/chat/${c.id}`}, icon('chat'), h('strong', {class: 'spacer ellipsis'}, c.title), h('span', {class: 'faint small'}, fmtAgo(c.updated))))));
  }

  function renderInstructions() {
    const ta = h('textarea', {class: 'input', rows: 10, placeholder: 'How should the model behave in this project? What should it always keep in mind?'});
    ta.value = project.instructions || '';
    const modelSel = h('select', {class: 'input'}, h('option', {value: ''}, 'Whatever the chat picks'),
      modelsOf('chat').map(m => h('option', {value: m.id, selected: m.id === project.model}, m.display_name || m.name)));
    const sizeSel = h('select', {class: 'input'}, Object.entries(CONTEXT_LABEL).map(([v, l]) => h('option', {value: v, selected: v === (project.context_size || 'medium')}, l)));
    const agentChk = h('input', {type: 'checkbox', checked: !!project.agent});
    body.append(card({title: 'Instructions', ic: 'edit', sub: 'Given to the model at the start of every chat in this project'}, h('div', {class: 'form'},
      h('div', {class: 'field'}, h('label', {}, 'Instructions'), ta),
      h('div', {class: 'form-row'}, h('div', {class: 'field'}, h('label', {}, 'Default model'), modelSel),
        h('div', {class: 'field'}, h('label', {}, 'How much of the files to give the model'), sizeSel,
          h('small', {class: 'hint'}, 'More context can mean better answers, but the model reads it before replying.'))),
      h('label', {class: 'check'}, agentChk, h('span', {}, h('span', {}, 'Start new chats in Agent mode'), h('small', {class: 'muted'}, 'The model can search the files itself, read web pages and use tools.'))),
      h('div', {}, btn('Save', async () => {
        project = {...project, ...(await ProjectsAPI.update(pid, {instructions: ta.value, model: modelSel.value, context_size: sizeSel.value, agent: agentChk.checked}))};
        toast('Saved', 'ok');
      }, {kind: 'primary'})))));
    if (!S.modelsAt) refreshModels().then(() => { if (tab === 'instructions' && ctx.alive()) { clear(body); renderInstructions(); } });
  }

  function renderMemory() {
    const facts = (project.memory?.facts || []).slice();
    const list = h('div', {class: 'stack-sm'});
    const toggle = switchInput(project.memory_enabled !== false, async v => {
      project = {...project, ...(await ProjectsAPI.update(pid, {memory_enabled: v}))};
      toast(v ? 'Memory is on' : 'Memory is off', 'ok');
    }, 'Remember things from chats');
    const save = async () => { project = {...project, ...(await ProjectsAPI.update(pid, {facts}))}; draw(); };
    function draw() {
      clear(list);
      if (!facts.length) { list.append(emptyState('brain', 'Nothing remembered yet', 'As you chat in this project, decisions, names, numbers and preferences are noted here automatically.')); return; }
      for (const f of facts) {
        list.append(h('div', {class: 'net'}, icon('brain'), h('div', {class: 'spacer', style: {minWidth: 0}}, h('div', {}, f.text), h('div', {class: 'faint small'}, `${f.source === 'you' ? 'Added by you' : 'From a chat'} · ${fmtAgo(f.created)}`)),
          iconBtn('edit', 'Edit', async () => {
            const v = await formDialog({title: 'Edit fact', fields: [{name: 'text', label: 'Fact', type: 'textarea', rows: 3, value: f.text, required: true, maxlength: 400}]});
            if (v) { f.text = v.text; await save(); }
          }),
          iconBtn('trash', 'Forget', async () => { facts.splice(facts.indexOf(f), 1); await save(); })));
      }
    }
    body.append(card({title: 'Project memory', ic: 'brain', sub: 'Facts from earlier chats that every new chat in this project starts with',
      actions: [h('label', {class: 'row gap-sm small'}, toggle, 'Remember automatically'),
        btn('Add', async () => {
          const v = await formDialog({title: 'Add a fact', fields: [{name: 'text', label: 'Fact', type: 'textarea', rows: 3, required: true, maxlength: 400, placeholder: 'The deadline is 1 May.'}]});
          if (v) { facts.push({text: v.text, source: 'you'}); await save(); }
        }, {small: true, icon: 'plus'}),
        facts.length ? btn('Forget all', async () => { if (await confirmDialog({title: 'Forget everything?', message: 'All remembered facts are removed.', confirmLabel: 'Forget all', danger: true})) { facts.length = 0; await save(); } }, {small: true, kind: 'ghost'}) : null]}, list));
    draw();
  }

  function renderSettings() {
    const name = h('input', {class: 'input', value: project.name, maxlength: 120});
    const desc = h('textarea', {class: 'input', rows: 3, maxlength: 2000});
    desc.value = project.description || '';
    body.append(card({title: 'Settings', ic: 'settings'}, h('div', {class: 'form'},
      h('div', {class: 'field'}, h('label', {}, 'Name'), name), h('div', {class: 'field'}, h('label', {}, 'Description'), desc),
      h('div', {}, btn('Save', async () => { project = {...project, ...(await ProjectsAPI.update(pid, {name: name.value.trim() || project.name, description: desc.value}))}; ctx.setTitle(project.name, project.description); toast('Saved', 'ok'); }, {kind: 'primary'})))),
    card({title: 'Delete project', ic: 'trash'}, h('div', {class: 'stack'},
      h('p', {class: 'muted small'}, 'Its files, index and memory are deleted. Files linked from a folder stay on your computer.'),
      h('div', {class: 'row wrap'},
        btn('Delete, keep its chats', () => remove('keep'), {kind: 'danger'}),
        btn('Delete it and its chats', () => remove('delete'), {kind: 'danger'})))));
  }
  async function remove(chats) {
    if (!(await confirmDialog({title: `Delete “${project.name}”?`, message: chats === 'delete' ? 'Its chats are deleted too. This can’t be undone.' : 'Its chats move to “Chats without a project”.', confirmLabel: 'Delete', danger: true}))) return;
    await ProjectsAPI.remove(pid, chats);
    toast('Project deleted', 'ok');
    go('projects');
  }
  load();
}

registerView({id: 'projects', order: 35, group: 'main', title: 'Projects', ic: 'folder', sub: 'Chats that share instructions, files and memory', render: viewProjects});
