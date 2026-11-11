/* Routines: the panel does things by itself on a schedule (tiinyui/routines.py). An agent prompt in its own chat, such
   as a morning briefing, or a code review of a folder that says what's new since last time. They run on this computer,
   by the panel, whether a page is open or not. */
'use strict';

const RoutinesAPI = {
  list: () => api('/api/routines'),
  create: body => api('/api/routines', {method: 'POST', body}),
  update: (id, body) => api(`/api/routines/${encodeURIComponent(id)}`, {method: 'PATCH', body}),
  del: id => api(`/api/routines/${encodeURIComponent(id)}`, {method: 'DELETE'}),
  run: id => api(`/api/routines/${encodeURIComponent(id)}/run`, {method: 'POST', body: {}}),
};
const ROUTINE_TEMPLATES = [
  {id: 'briefing', title: 'Morning briefing', ic: 'spark', sub: 'Weekday mornings: the news and what’s in your Vault for today', spec: () => ({
    name: 'Morning briefing', schedule: {kind: 'weekdays', time: '08:00'},
    action: {kind: 'agent', prompt: 'Good morning! Give me a short briefing for today: the date, three news headlines worth knowing (search the web), ' +
      'and anything in my Vault that looks relevant for today. Keep it under 200 words.', tools: ['web_search', 'fetch_web_page'], use_vault: true}})},
  {id: 'review', title: 'Weekly code review', ic: 'shield', sub: 'Fridays: review a folder and say what’s new', computerOnly: true, spec: () => ({
    name: 'Weekly code review', schedule: {kind: 'weekly', days: [4], time: '17:00'}, action: {kind: 'review', focus: 'security'}})},
  {id: 'custom', title: 'Your own prompt', ic: 'edit', sub: 'Ask the agent anything, on a schedule', spec: () => ({
    name: '', schedule: {kind: 'daily', time: '09:00'}, action: {kind: 'agent', prompt: '', tools: []}})},
];
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const RUN_BADGE = {done: ['Done', 'ok', 'check'], failed: ['Failed', 'err', 'alert'], stopped: ['Stopped', '', 'stop'], running: ['Running', 'accent', 'activity'],
  skipped: ['Skipped', '', 'clock'], interrupted: ['Interrupted', 'warn', 'alert']};

function fmtWhen(ts) {   // "today 08:00", "tomorrow 08:00", "Mon 9 Nov, 08:00"
  if (!ts) return '';
  const d = new Date(ts * 1000), now = new Date();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((day - today) / 86400000);
  const time = d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `tomorrow ${time}`;
  return `${d.toLocaleDateString([], {weekday: 'short', day: 'numeric', month: 'short'})}, ${time}`;
}

function viewRoutines(root, ctx) {
  const remote = !!S.health?.remote;
  const listBody = h('div', {}, loadingBlock());
  let items = [];
  root.append(
    h('div', {class: 'banner info'}, icon('clock'), h('div', {class: 'text'}, h('strong', {}, 'Routines run by themselves, on a schedule'),
      h('span', {class: 'small'}, `The panel runs them on ${hereName()}, even when no page is open. They never unload your models, and what they ` +
        'load is unloaded again afterwards. Commands and file changes always wait for your OK.'))),
    card({title: 'Your routines', icon: 'clock', sub: `Times are ${hereName()}’s local time`,
      actions: [menuButton(ROUTINE_TEMPLATES.filter(t => !(t.computerOnly && remote)).map(t => ({label: t.title, icon: t.ic, fn: () => edit(null, t)})),
        {ic: 'plus', label: 'New routine', title: 'New routine'})]}, listBody));

  async function load() {
    try { items = (await RoutinesAPI.list()).routines || []; }
    catch (e) { clear(listBody).append(errorBlock(e.message, {retry: load, title: 'Couldn’t load the routines'})); return; }
    if (ctx.alive()) render();
  }
  function render() {
    if (!items.length) {
      clear(listBody).append(h('div', {class: 'stack'}, emptyState('clock', 'No routines yet', 'Start from one of these, then change what it does and when.'),
        h('div', {class: 'routine-templates'}, ROUTINE_TEMPLATES.filter(t => !(t.computerOnly && remote)).map(t =>
          h('button', {class: 'routine-template', type: 'button', onclick: () => edit(null, t)}, icon(t.ic), h('strong', {}, t.title), h('small', {class: 'muted'}, t.sub))))));
      return;
    }
    clear(listBody).append(h('div', {class: 'routine-list'}, items.map(row)));
  }
  function row(r) {
    const a = r.action || {};
    const last = (r.runs || [])[0];
    const running = r.running;
    const state = running ? (running.waiting ? badge('Waiting for your OK', 'warn', 'shield') : badge('Running now', 'accent', 'activity'))
      : !r.enabled ? badge('Off') : r.postponed ? badge('Waiting for your Tiiny', 'warn', 'clock') : null;
    const next = r.enabled && r.next_run && !running ? `Next: ${fmtWhen(r.next_run)}` : '';
    const lastLine = last ? h('div', {class: 'routine-last small'}, badge(...(RUN_BADGE[last.status] || [last.status, ''])),
      h('span', {class: 'muted'}, fmtAgo(last.at)), last.summary ? h('span', {class: 'routine-summary', title: last.summary}, last.summary) : null,
      last.link ? h('a', {href: last.link, class: 'small'}, a.kind === 'review' ? 'Open the review' : 'Open the chat') : null) : null;
    const lockReview = remote && a.kind === 'review';
    return h('div', {class: 'routine-row'},
      h('div', {class: 'model-icon'}, icon(a.kind === 'review' ? 'shield' : 'spark')),
      h('div', {class: 'routine-main'},
        h('div', {class: 'row gap-sm wrap'}, h('strong', {}, r.name), state),
        h('small', {class: 'muted'}, [cap(r.when || ''), next, a.kind === 'review' ? a.folder : (a.model ? shortName(a.model) : '')].filter(Boolean).join(' · ')),
        r.postponed && !running ? h('small', {class: 'muted'}, r.postponed) : null,
        lastLine),
      h('div', {class: 'routine-actions'},
        switchInput(!!r.enabled, async v => { try { await RoutinesAPI.update(r.id, {enabled: v}); } catch (e) { toast('Couldn’t change it', 'err', {detail: e.message}); } load(); },
          r.enabled ? 'Switch off' : 'Switch on'),
        btn('Run now', async () => {
          try { await RoutinesAPI.run(r.id); toast(`${r.name} is running`, 'ok', {timeout: 2500}); setTimeout(load, 800); }
          catch (e) { toast('Couldn’t run it', 'err', {detail: e.message}); }
        }, {small: true, kind: 'ghost', icon: 'play', disabled: !!running}),
        menuButton([
          lockReview ? null : {label: 'Edit', icon: 'edit', fn: () => edit(r)},
          {label: 'Past runs', icon: 'list', fn: () => showRuns(r)},
          lockReview ? null : {label: 'Delete', icon: 'trash', danger: true, fn: () => remove(r)},
        ].filter(Boolean))));
  }

  async function edit(r, template) {
    const spec = await routineDialog(r, template?.spec(), remote);
    if (!spec) return;
    try {
      if (r) await RoutinesAPI.update(r.id, spec); else await RoutinesAPI.create(spec);
      toast(r ? `${spec.name} saved` : `${spec.name} is set up`, 'ok', {timeout: 2500});
      load();
    } catch (e) { toast('Couldn’t save the routine', 'err', {detail: e.message}); }
  }
  async function remove(r) {
    const ok = await confirmDialog({title: `Delete ${r.name}?`, danger: true, confirmLabel: 'Delete',
      message: r.action?.kind === 'review' ? 'It stops running. Its code review stays on the Code review page.' : 'It stops running. Its chat stays in your chats.'});
    if (!ok) return;
    try { await RoutinesAPI.del(r.id); load(); } catch (e) { toast('Couldn’t delete it', 'err', {detail: e.message}); }
  }
  function showRuns(r) {
    const runs = r.runs || [];
    const md = modal({title: `${r.name}: past runs`, size: 'lg',
      body: runs.length ? h('div', {class: 'routine-runs'}, runs.map(x => h('div', {class: 'routine-run'},
        badge(...(RUN_BADGE[x.status] || [x.status, ''])), h('span', {class: 'small muted'}, new Date(x.at * 1000).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})),
        h('span', {class: 'small spacer'}, x.summary || ''), x.link ? h('a', {href: x.link, class: 'small', onclick: () => md.close()}, 'Open') : null)))
        : emptyState('clock', 'It hasn’t run yet', r.enabled && r.next_run ? `It runs ${fmtWhen(r.next_run)}.` : 'Switch it on, or press Run now.'),
      actions: [h('button', {class: 'btn primary', type: 'button', onclick: () => md.close()}, 'Close')]});
  }

  load();
  const poll = setInterval(() => { if (!document.hidden) load(); }, 5000);
  ctx.onCleanup(() => clearInterval(poll));
}

/* The routine's form. Resolves to what to save, or null. A phone can't set up code reviews or tools that work on this
   computer's files (the panel refuses them too). */
function routineDialog(existing, template, remote) {
  return new Promise(async resolve => {
    let done = false;
    const base = existing || template;
    const act = {...(base.action || {})};
    const kind = act.kind || 'agent';
    const sched = {...(base.schedule || {kind: 'daily', time: '09:00'})};
    if (!S.modelsAt) await refreshModels().catch(() => {});
    const chatModels = modelsOf('chat').sort((x, y) => S.running.has(y.id) - S.running.has(x.id));
    const projects = kind === 'agent' ? await ProjectsAPI.list().catch(() => []) : [];
    const field = (label, input, hint) => h('div', {class: 'field'}, h('label', {}, label), input, hint ? h('small', {class: 'hint'}, hint) : null);
    const name = h('input', {class: 'input', maxlength: 80, value: base.name || '', 'aria-label': 'Name'});
    const model = h('select', {class: 'input', 'aria-label': 'Model'}, chatModels.map(m => h('option', {value: m.id, selected: m.id === act.model},
      `${S.running.has(m.id) ? '● ' : ''}${m.display_name || m.name || shortName(m.id)}`)));
    if (act.model && !chatModels.some(m => m.id === act.model)) model.append(h('option', {value: act.model, selected: true}, act.model));
    // what it does
    let body, collect;
    if (kind === 'agent') {
      const prompt = h('textarea', {class: 'input', rows: 5, maxlength: 4000, 'aria-label': 'What to ask'});
      prompt.value = act.prompt || '';
      const allowed = new Set(act.tools || []);
      const boxes = new Map();
      const groups = TOOL_GROUPS.map(([g, label]) => {
        const tools = AgentTools.filter(t => t.group === g && t.risk !== 'read' && !t.alwaysAsk && !(remote && ['command', 'file', 'open', 'computer'].includes(t.risk)) &&
          !(g === 'computer' && !S.health?.commands?.enabled));
        if (!tools.length) return null;
        return h('div', {class: 'stack-sm'}, h('small', {class: 'muted'}, label), h('div', {class: 'scope-grid'}, tools.map(t => {
          const c = h('input', {type: 'checkbox', checked: allowed.has(t.name)});
          boxes.set(t.name, c);
          return h('label', {class: 'check'}, c, h('span', {}, TOOL_SHORT[toolKey(t)] || t.title));
        })));
      }).filter(Boolean);
      const project = h('select', {class: 'input', 'aria-label': 'Project'}, [h('option', {value: ''}, 'No project'),
        ...projects.map(p => h('option', {value: p.id, selected: p.id === act.project_id}, p.name))]);
      const vault = h('input', {type: 'checkbox', checked: !!act.use_vault});
      body = [field('What to ask', prompt, 'It goes into the routine’s own chat each time, and the agent answers there.'),
        field('Model', model, 'If it isn’t loaded and fits next to your models, it’s loaded for the run and unloaded again afterwards. Your models are never unloaded for it.'),
        h('div', {class: 'field'}, h('label', {}, 'It may use by itself'), ...groups,
          h('small', {class: 'hint'}, 'Tools that only look (search the Vault, check the device, the time) always run. Others it may not use are refused. ' +
            `Commands and file changes on ${hereName()} always wait for your OK in its chat.`)),
        projects.length ? field('Project', project, 'Use a project’s instructions, files and memory.') : null,
        h('label', {class: 'check'}, vault, h('span', {}, h('span', {}, 'Use my Vault'), h('small', {class: 'muted'}, 'Search your Vault for each run.')))];
      collect = () => ({kind: 'agent', prompt: prompt.value.trim(), model: model.value, tools: [...boxes].filter(([, c]) => c.checked).map(([k]) => k),
        project_id: project.value || null, use_vault: vault.checked});
    } else {
      const folder = h('input', {class: 'input mono', value: act.folder || '', placeholder: '/home/you/projects/app', 'aria-label': 'Folder', spellcheck: 'false'});
      let focus = act.focus || 'security';
      const think = h('input', {type: 'checkbox', checked: !!act.thinking});
      body = [field('Folder', h('div', {class: 'row gap-sm'}, folder, btn('Choose…', async () => {
        const p = await folderPicker({title: 'Folder to review', start: folder.value});
        if (p) folder.value = p;
      }, {small: true, kind: 'ghost', icon: 'folder'})), 'Its files are looked at again each time, so new ones are included.'),
        field('Model', model, 'Loaded for the review if it fits next to your models, and unloaded again afterwards.'),
        field('Look for', segmented([['security', 'Security'], ['bugs', 'Bugs'], ['all', 'Both']], focus, v => { focus = v; })),
        h('label', {class: 'check'}, think, h('span', {}, h('span', {}, 'Let the model think first'), h('small', {class: 'muted'}, 'Slower, sometimes finds more.')))];
      collect = () => ({kind: 'review', folder: folder.value.trim(), model: model.value, focus, thinking: think.checked});
    }
    // when
    const kindSel = h('select', {class: 'input', 'aria-label': 'When'}, [['daily', 'Every day'], ['weekdays', 'On weekdays'], ['weekly', 'On some days'], ['hours', 'Every few hours']]
      .map(([k, l]) => h('option', {value: k, selected: k === sched.kind}, l)));
    const time = h('input', {class: 'input', type: 'time', value: sched.time || '09:00', 'aria-label': 'Time', style: {width: 'auto'}});
    const every = h('input', {class: 'input', type: 'number', min: 1, max: 168, value: sched.every || 4, 'aria-label': 'Hours', style: {width: '6em'}});
    const days = new Set(sched.days || [0]);
    const dayBoxes = h('div', {class: 'row wrap gap-sm'}, DAY_SHORT.map((d, i) => {
      const c = h('input', {type: 'checkbox', checked: days.has(i)});
      c.addEventListener('change', () => { if (c.checked) days.add(i); else days.delete(i); });
      return h('label', {class: 'check'}, c, h('span', {}, d));
    }));
    const whenExtra = h('div', {class: 'stack-sm'});
    const showWhen = () => {
      const k = kindSel.value;
      clear(whenExtra).append(k === 'hours' ? h('div', {class: 'row gap-sm'}, h('span', {}, 'Every'), every, h('span', {}, 'hours'))
        : h('div', {class: 'stack-sm'}, k === 'weekly' ? dayBoxes : null, h('div', {class: 'row gap-sm'}, h('span', {}, 'At'), time)));
    };
    kindSel.addEventListener('change', showWhen);
    showWhen();
    const enabled = h('input', {type: 'checkbox', checked: existing ? !!existing.enabled : true});
    const err = h('p', {class: 'field-error'});
    const md = modal({title: existing ? `Edit ${existing.name}` : (template?.name || 'New routine'), size: 'lg', onClose: () => { if (!done) resolve(null); },
      body: h('div', {class: 'form'},
        field('Name', name, 'Shown here, on the Dashboard while it runs, and as its chat’s title.'),
        ...body,
        h('div', {class: 'field'}, h('label', {}, 'When'), kindSel, whenExtra),
        h('label', {class: 'check'}, enabled, h('span', {}, 'On')),
        err),
      actions: [h('button', {class: 'btn ghost', type: 'button', onclick: () => md.close()}, 'Cancel'),
        h('button', {class: 'btn primary', type: 'button', onclick: () => {
          const action = collect();
          const k = kindSel.value;
          const schedule = k === 'hours' ? {kind: k, every: Number(every.value)} : {kind: k, time: time.value, ...(k === 'weekly' ? {days: [...days].sort()} : {})};
          if (!name.value.trim()) { err.textContent = 'Give the routine a name.'; return; }
          if (!action.model) { err.textContent = 'There’s no chat model on your Tiiny to run it with.'; return; }
          if (action.kind === 'agent' && !action.prompt) { err.textContent = 'Write what it should ask.'; return; }
          if (action.kind === 'review' && !action.folder) { err.textContent = 'Choose the folder to review.'; return; }
          if (k === 'weekly' && !days.size) { err.textContent = 'Pick at least one day.'; return; }
          if (k === 'hours' && !(schedule.every >= 1 && schedule.every <= 168)) { err.textContent = 'Every 1 to 168 hours.'; return; }
          if (k !== 'hours' && !/^\d{1,2}:\d{2}$/.test(time.value)) { err.textContent = 'Give a time, for example 08:00.'; return; }
          done = true;
          md.close();
          resolve({name: name.value.trim(), enabled: enabled.checked, schedule, action});
        }}, existing ? 'Save' : 'Set it up')]});
    setTimeout(() => (base.name ? model : name).focus(), 50);
  });
}

registerView({id: 'routines', order: 45, group: 'main', title: 'Routines', ic: 'clock', sub: 'Agent prompts and code reviews that run by themselves on a schedule', render: viewRoutines});
