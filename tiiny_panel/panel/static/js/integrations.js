/* Integrations: other apps on this computer use your Tiiny through the panel's gateway, each with its own key
   (tiinyui/gateway.py), and AI assistants use its tools (MCP, tiinyui/mcp.py). Setups are filled in for each app. */
'use strict';

/* Apps you can add, with the scopes they start with. mcp: they're AI assistants that use the Tiiny's tools. */
const APP_PRESETS = [
  {id: 'claude-code', name: 'Claude Code', ic: 'terminal', mcp: true, scopes: ['mcp', 'chat', 'images', 'audio', 'ocr', 'vault_read', 'decisions']},
  {id: 'claude-desktop', name: 'Claude Desktop', ic: 'chat', mcp: true, scopes: ['mcp', 'chat', 'images', 'audio', 'ocr', 'vault_read', 'decisions']},
  {id: 'cursor', name: 'Cursor', ic: 'edit', mcp: true, scopes: ['mcp', 'chat', 'images', 'audio', 'ocr', 'vault_read']},
  {id: 'openclaw', name: 'OpenClaw', ic: 'bolt', mcp: true, scopes: ['chat', 'embeddings', 'mcp', 'images', 'audio', 'vault_read']},
  {id: 'hermes', name: 'Hermes Agent', ic: 'bolt', mcp: true, scopes: ['chat', 'embeddings', 'mcp', 'images', 'audio', 'vault_read']},
  {id: 'open-webui', name: 'Open WebUI', ic: 'chat', scopes: ['chat', 'embeddings', 'images', 'audio']},
  {id: 'continue', name: 'Continue', ic: 'edit', scopes: ['chat', 'embeddings']},
  {id: 'zed', name: 'Zed', ic: 'edit', scopes: ['chat']},
  {id: 'aider', name: 'aider', ic: 'terminal', scopes: ['chat']},
  {id: 'llm', name: 'llm (command line)', ic: 'terminal', scopes: ['chat', 'embeddings']},
  {id: 'obsidian', name: 'Obsidian Copilot', ic: 'edit', scopes: ['chat', 'embeddings']},
  {id: 'ollama-app', name: 'An Ollama app', ic: 'chat', scopes: ['chat', 'embeddings']},
  {id: 'custom', name: 'My own code', ic: 'terminal', scopes: ['chat', 'embeddings']},
];
const presetOf = id => APP_PRESETS.find(p => p.id === id) || APP_PRESETS[APP_PRESETS.length - 1];
const POLICY_LABEL = {loaded: 'Only models that are loaded', fits: 'Load models that fit, never unload others', make_room: 'Make room by unloading idle models'};
const SCOPE_SHORT = {chat: 'Chat', embeddings: 'Embeddings', images: 'Pictures', audio: 'Speech', ocr: 'OCR', decisions: 'Decisions',
  vault_read: 'Vault: search', vault_write: 'Vault: save', mcp: 'Tools (MCP)'};
const unloadLabel = v => v === null || v === undefined ? 'keep them loaded' : v === 0 ? 'straight away' : `after ${fmtSecs(v)}`;

function viewIntegrations(root, ctx) {
  const remote = !!S.health?.remote;   // a paired phone: apps and keys are managed on the computer
  const info = S.health?.device || {};
  const devHost = info.address ? `${info.address.includes(':') ? `[${info.address}]` : info.address}${info.port && info.port !== 80 ? `:${info.port}` : ''}` : '<device-ip>';
  const DEVICE = `http://${devHost}`;
  let st = null;   // /api/apps: {apps, gateway, scopes, unload_choices, bridge}
  let model = '';
  const G = () => st?.gateway?.url || 'http://127.0.0.1:8766';
  const appsBody = h('div', {}, loadingBlock());
  const out = h('div', {class: 'stack'});
  const modelSel = h('select', {class: 'input sm', style: {width: 'auto', maxWidth: 'min(300px, 100%)'}, 'aria-label': 'Model for the examples'});
  const fillModels = () => {
    const list = modelsOf('chat').sort((a, b) => S.running.has(b.id) - S.running.has(a.id));
    clear(modelSel);
    for (const m of list) modelSel.append(h('option', {value: m.id}, `${S.running.has(m.id) ? '● ' : ''}${m.display_name || m.name || shortName(m.id)}`));
    if (!list.length) modelSel.append(h('option', {value: 'default'}, 'default'));
    if (list.some(m => m.id === model)) modelSel.value = model; else model = modelSel.value;
  };
  modelSel.addEventListener('change', () => { model = modelSel.value; render(); });
  const tests = h('div', {class: 'stack-sm'});
  const testBtn = (label, fn) => btn(label, async () => {
    const row = h('div', {class: 'row small'}, h('span', {class: 'spinner'}), `${label}…`);
    tests.prepend(row);
    const t0 = performance.now();
    let ok = false, detail = '';
    try { [ok, detail] = await fn(); } catch (e) { detail = e.message; }
    const ms = Math.round(performance.now() - t0);
    clear(row).append(badge(ok ? 'Works' : 'Failed', ok ? 'ok' : 'err', ok ? 'check' : 'alert'), h('strong', {}, label.replace(/^Test the /, '')), h('span', {class: 'muted'}, `${ms} ms · ${detail}`));
  }, {small: true, icon: 'play'});
  const needModel = () => S.running.has(model) || [...S.running].some(id => S.modelsById.get(id) && TYPES.chat(S.modelsById.get(id)));

  // the device's own key, for apps elsewhere in your network (advanced)
  let devKey = null;
  const keyLine = h('code', {}, info.key_hint || '(no key: log in on the Account page)');
  const direct = h('details', {class: 'card direct'},
    h('summary', {}, icon('key'), h('span', {}, 'Talk to the device directly (advanced)')),
    h('div', {class: 'stack', style: {marginTop: '12px'}},
      h('p', {class: 'small muted'}, 'Apps anywhere in your network can also talk to your Tiiny directly, with the device’s own key. That key can also ' +
        'manage the device: load and unload models, restart it, change its Wi-Fi. An app key from the gateway above can’t, so use one of those when you can.'),
      kvList([['OpenAI-compatible', h('code', {}, `${DEVICE}/v1`)], ['Anthropic and Ollama', h('code', {}, DEVICE)],
        ['Device key', remote ? h('span', {class: 'muted'}, 'Shown on the computer that runs the panel') : h('span', {class: 'row gap-sm wrap'}, keyLine,
          btn('Reveal', async () => { devKey = (await api('/api/device/key')).key; keyLine.textContent = devKey || '(none)'; }, {small: true, kind: 'ghost', icon: 'eye'}),
          btn('Copy', async () => copyText(devKey || (await api('/api/device/key')).key, 'Device key copied'), {small: true, kind: 'ghost', icon: 'copy'}))]])));

  root.append(
    h('div', {class: 'banner info'}, icon('plug'), h('div', {class: 'text'}, h('strong', {}, 'Your Tiiny works with apps made for OpenAI, Anthropic (Claude) and Ollama, and with AI assistants'),
      h('span', {class: 'small'}, `Apps on ${hereName()} connect through the panel: each gets its own key, models load when an app needs them, and an app can’t manage your device.`))),
    card({title: 'Apps that use your Tiiny', ic: 'plug', sub: 'Each app has its own key; revoke one any time',
      actions: remote ? null : [btn('Add an app', () => { addApp(); }, {kind: 'primary', icon: 'plus', small: true})]}, appsBody),
    card({title: 'Test the APIs', ic: 'play'}, h('div', {class: 'stack'},
      h('div', {class: 'row wrap gap-sm'}, h('span', {class: 'small muted'}, 'Model in the examples below'), modelSel),
      h('div', {class: 'row wrap gap-sm'},
        testBtn('Test the OpenAI API', async () => {
          const r = await dev('/v1/models', {quiet: true, silent: true});
          return [r.ok, r.ok ? `${(r.json?.data || []).length} model(s) loaded` : r.error];
        }),
        testBtn('Test the Anthropic API', async () => {
          if (!needModel()) return [false, 'load a chat model first'];
          const r = await dev('/v1/messages', {method: 'POST', json: {model: S.running.has(model) ? model : 'default', max_tokens: 60, thinking: {type: 'disabled'}, messages: [{role: 'user', content: 'Reply with just: hello'}]}, quiet: true, silent: true, timeout: 120});
          const text = (r.json?.content || []).map(c => c.text || '').join('').trim();
          return [r.ok, r.ok ? (text ? `replied “${text.slice(0, 40)}”` : 'answered (only thinking so far)') : r.error];
        }),
        testBtn('Test the Ollama API', async () => {
          const r = await dev('/api/tags', {quiet: true, silent: true});
          return [r.ok, r.ok ? `${(r.json?.models || []).length} model(s) listed` : r.error];
        }),
        testBtn('Test decision models', async () => {
          const loaded = modelsOf('decide').find(m => S.running.has(m.id));
          if (!loaded) return [false, modelsOf('decide').length ? 'load a decision model first' : 'no decision model on your Tiiny'];
          const r = await dev('/v1/systemone', {method: 'POST', json: {model: loaded.id, state: 'The sky is blue.', questions: {t: {type: 'noul', instructions: 'Is this statement true?'}}}, quiet: true, silent: true});
          const p = r.json?.answers?.t?.noul;
          return [r.ok, r.ok ? `${shortName(loaded.id)}: “the sky is blue” is true with ${Math.round((p ?? 0) * 100)}%` : r.error];
        })),
      h('p', {class: 'small muted'}, 'These check the device itself, through the panel. Apps reach it through the gateway address above.'),
      tests)),
    out,
    direct);

  /* ---- the apps card -------------------------------------------------------------------------------------- */
  async function load() {
    if (remote) {
      clear(appsBody).append(h('p', {class: 'muted'}, 'Apps and their keys are managed on the computer that runs the panel.'));
      render();
      return;
    }
    try { st = await api('/api/apps'); }
    catch (e) { clear(appsBody).append(errorBlock(e.message, {retry: load, title: 'Couldn’t load the apps'})); return; }
    if (!ctx.alive()) return;
    renderApps();
    render();
  }
  async function setGateway(patch) {
    try { st.gateway = await api('/api/gateway', {method: 'POST', body: patch}); }
    catch (e) { toast('Couldn’t change the gateway', 'err', {detail: e.message}); }
    renderApps();
    render();
  }
  function renderApps() {
    const g = st.gateway;
    const state = g.running ? badge('Running', 'ok', 'check') : g.enabled ? badge('Not running', 'err', 'alert') : badge('Switched off', '', 'power');
    const lan = g.lan;
    clear(appsBody).append(h('div', {class: 'stack'},
      h('div', {class: 'row wrap gap-sm'}, state, h('code', {}, g.url), iconBtn('copy', 'Copy the address', () => copyText(g.url, 'Address copied')),
        h('span', {class: 'spacer'}), h('span', {class: 'small muted'}, 'Gateway'), switchInput(g.enabled, v => setGateway({enabled: v}), 'Gateway on')),
      g.error ? h('div', {class: 'banner err'}, icon('alert'), h('div', {class: 'text'}, h('strong', {}, 'The gateway isn’t running'),
        h('span', {class: 'small'}, `${g.error} Start the panel with --gateway-port and another port, or stop the other program.`))) : null,
      h('div', {class: 'stack-sm small'},
        h('div', {class: 'row wrap gap-sm'}, switchInput(lan.enabled, v => setGateway({lan: v}), 'Apps on other computers'),
          h('span', {}, 'Apps on other computers in your network'), lan.running ? h('code', {}, lan.url) : lan.error ? h('span', {class: 'muted'}, lan.error) : null),
        lan.enabled && !lan.tls ? h('p', {class: 'muted'}, 'Keys and answers then travel unencrypted through your network. For HTTPS, start the panel with --tls-cert and --tls-key.') : null,
        h('div', {class: 'row wrap gap-sm'}, switchInput(g.keyless_ollama, v => setGateway({keyless_ollama: v}), 'Ollama apps without a key'),
          h('span', {}, 'Let Ollama apps that can’t send a key chat and make embeddings (from this computer only)'))),
      st.apps.length ? h('div', {class: 'app-list'}, st.apps.map(appRow))
        : emptyState('plug', 'No apps yet', 'Add one to give it its own key, with the setup filled in.', btn('Add an app', () => { addApp(); }, {kind: 'primary', icon: 'plus'}))));
  }
  function appRow(a) {
    const p = presetOf(a.preset);
    const tokens = (a.tokens_in || 0) + (a.tokens_out || 0);
    const meta = [a.last_used ? `Last used ${fmtAgo(a.last_used)}` : 'Not used yet', `${a.requests || 0} request${a.requests === 1 ? '' : 's'}`,
      tokens ? `${fmtCount(tokens)} tokens` : null, a.last_model ? shortName(a.last_model) : null].filter(Boolean).join(' · ');
    return h('div', {class: 'app-row'},
      h('div', {class: 'model-icon'}, icon(p.ic)),
      h('div', {class: 'app-main'},
        h('div', {class: 'row gap-sm wrap'}, h('strong', {}, a.name), h('span', {class: 'faint small mono'}, `tiiny_…${a.hint}`)),
        h('small', {class: 'muted'}, meta),
        h('div', {class: 'row wrap gap-sm'}, a.scopes.map(s => badge(SCOPE_SHORT[s] || s))),
        h('small', {class: 'muted'}, `${POLICY_LABEL[a.policy] || a.policy}; models it loaded are unloaded ${unloadLabel(a.unload_after)}.`)),
      h('div', {class: 'app-actions'},
        btn('Setup', () => { setupDialog(a, null); }, {small: true, kind: 'ghost', icon: 'book'}),
        menuButton([
          {label: 'Edit', icon: 'edit', fn: () => editApp(a)},
          {label: 'New key', icon: 'key', fn: () => newKey(a)},
          {label: 'Revoke', icon: 'trash', danger: true, fn: () => revoke(a)},
        ])));
  }

  /* ---- adding, editing, keys ------------------------------------------------------------------------------ */
  function appDialog(existing) {
    return new Promise(resolve => {
      let done = false, preset = existing ? presetOf(existing.preset) : APP_PRESETS[0], nameTouched = !!existing;
      const presetSel = h('select', {class: 'input', 'aria-label': 'App'}, APP_PRESETS.map(p => h('option', {value: p.id, selected: p.id === preset.id}, p.name)));
      const name = h('input', {class: 'input', maxlength: 60, value: existing?.name || preset.name, 'aria-label': 'Name'});
      name.addEventListener('input', () => { nameTouched = true; });
      const boxes = new Map();
      const scopeGrid = h('div', {class: 'scope-grid'}, Object.entries(st.scopes).map(([k, label]) => {
        const c = h('input', {type: 'checkbox', checked: (existing?.scopes || preset.scopes).includes(k)});
        boxes.set(k, c);
        return h('label', {class: 'check'}, c, h('span', {}, label));
      }));
      const policy = h('select', {class: 'input'}, Object.entries(POLICY_LABEL).map(([k, l]) => h('option', {value: k, selected: k === (existing?.policy || 'fits')}, l)));
      const choices = [...st.unload_choices, null];
      const current = existing ? existing.unload_after : 600;
      const unload = h('select', {class: 'input'}, choices.map(v => h('option', {value: String(v), selected: v === current}, v === null ? 'Keep them loaded' : v === 0 ? 'Straight away' : `After ${fmtSecs(v)}`)));
      const chat = modelsOf('chat');
      const defModel = h('select', {class: 'input'}, [h('option', {value: ''}, 'Automatic: a loaded one, else the smallest'),
        ...chat.map(m => h('option', {value: m.id, selected: m.id === existing?.default_model}, m.display_name || m.name || shortName(m.id)))]);
      presetSel.addEventListener('change', () => {
        preset = presetOf(presetSel.value);
        if (!nameTouched) name.value = preset.name;
        for (const [k, c] of boxes) c.checked = preset.scopes.includes(k);
      });
      const err = h('p', {class: 'field-error'});
      const field = (label, input, hint) => h('div', {class: 'field'}, h('label', {}, label), input, hint ? h('small', {class: 'hint'}, hint) : null);
      const md = modal({title: existing ? `Edit ${existing.name}` : 'Add an app', size: 'lg', onClose: () => { if (!done) resolve(null); },
        body: h('div', {class: 'form'},
          existing ? null : field('App', presetSel, 'Fills in the setup and what it may use; you can change both.'),
          field('Name', name, 'Shown here and on the dashboard while it works.'),
          h('div', {class: 'field'}, h('label', {}, 'It may use'), scopeGrid,
            h('small', {class: 'hint'}, 'Managing models, restarting the device, its Wi-Fi and your account are never allowed.')),
          field('Loading models', policy, 'What happens when it asks for a model that isn’t loaded. Models you pinned, and busy ones, are never unloaded.'),
          field('Models it had to load', unload, 'Unloaded again this long after its last request.'),
          field('Model for “default”', defModel, 'When the app doesn’t name a model and no chat model is loaded.'),
          err),
        actions: [h('button', {class: 'btn ghost', type: 'button', onclick: () => md.close()}, 'Cancel'),
          h('button', {class: 'btn primary', type: 'button', onclick: () => {
            const scopes = [...boxes].filter(([, c]) => c.checked).map(([k]) => k);
            if (!name.value.trim()) { err.textContent = 'Give the app a name.'; return; }
            if (!scopes.length) { err.textContent = 'Choose at least one thing it may use.'; return; }
            done = true;
            md.close();
            resolve({name: name.value.trim(), preset: preset.id, scopes, policy: policy.value, unload_after: unload.value === 'null' ? null : Number(unload.value), default_model: defModel.value});
          }}, existing ? 'Save' : 'Add and make a key')]});
    });
  }
  async function addApp() {
    const spec = await appDialog(null);
    if (!spec) return;
    try {
      const r = await api('/api/apps', {method: 'POST', body: spec});
      await load();
      setupDialog(r.app, r.key);
    } catch (e) { toast('Couldn’t add the app', 'err', {detail: e.message}); }
  }
  async function editApp(a) {
    const spec = await appDialog(a);
    if (!spec) return;
    delete spec.preset;
    try { await api(`/api/apps/${a.id}`, {method: 'PATCH', body: spec}); toast(`${spec.name} saved`, 'ok', {timeout: 2000}); await load(); }
    catch (e) { toast('Couldn’t save', 'err', {detail: e.message}); }
  }
  async function newKey(a) {
    const ok = await confirmDialog({title: `Make a new key for ${a.name}?`, confirmLabel: 'Make a new key',
      message: 'The old key stops working straight away, so the app needs the new one.'});
    if (!ok) return;
    try { const r = await api(`/api/apps/${a.id}/key`, {method: 'POST', body: {}}); await load(); setupDialog(r.app, r.key); }
    catch (e) { toast('Couldn’t make a new key', 'err', {detail: e.message}); }
  }
  async function revoke(a) {
    const ok = await confirmDialog({title: `Revoke ${a.name}?`, danger: true, confirmLabel: 'Revoke',
      message: 'Its key stops working straight away. Models it loaded are still unloaded as planned.'});
    if (!ok) return;
    try { await api(`/api/apps/${a.id}`, {method: 'DELETE'}); toast(`${a.name} revoked`, 'ok', {timeout: 2000}); await load(); }
    catch (e) { toast('Couldn’t revoke it', 'err', {detail: e.message}); }
  }
  /* The setup for one app. With `key` (just made) it's filled in; the key is shown this once only. */
  function setupDialog(a, key) {
    const K = key || 'YOUR_APP_KEY';
    const body = h('div', {class: 'stack'},
      key ? h('div', {class: 'stack-sm'},
        h('p', {}, h('strong', {}, 'Copy this key now: '), 'it’s shown only this once. The panel keeps just a fingerprint of it.'),
        h('div', {class: 'key-box'}, h('code', {}, key), btn('Copy key', () => copyText(key, 'Key copied'), {small: true, icon: 'copy', kind: 'primary'})))
        : h('p', {class: 'small muted'}, `Use the key you saved when you added ${a.name} (it ends in ${a.hint}). Lost it? Make a new one from the app’s menu.`),
      h('div', {class: 'snippets'}, setupsFor(a.preset, K)));
    const md = modal({title: key ? `${a.name} is ready` : `Set up ${a.name}`, size: 'lg', body,
      actions: [h('button', {class: 'btn primary', type: 'button', onclick: () => md.close()}, 'Done')]});
  }

  /* ---- setups ---------------------------------------------------------------------------------------------- */
  function snippet(title, lang, code, note) {
    return h('div', {class: 'snippet'}, h('div', {class: 'snippet-head'}, h('strong', {}, title), h('span', {class: 'faint small'}, lang),
      h('span', {class: 'spacer'}), iconBtn('copy', `Copy ${title}`, () => copyText(code, `${title} copied`))),
      note ? h('p', {class: 'small muted'}, note) : null, h('pre', {class: 'code-block'}, code));
  }
  function setupsFor(pid, K) {
    const B = G(), M = model || 'default';
    const py = st?.bridge?.python || 'python3', script = st?.bridge?.script || '/path/to/tiiny_ui.py';
    const json = o => JSON.stringify(o, null, 2);
    switch (pid) {
      case 'claude-code': return [
        snippet('Claude Code', 'shell', `claude mcp add -s user --transport http tiiny ${B}/mcp --header "Authorization: Bearer ${K}"`,
          'Gives Claude Code the Tiiny’s tools: ask a local model, make and edit pictures, transcribe, speak, read text in pictures, search your Vault. -s user makes them available in every project.'),
        snippet('Claude Code, over stdio', 'shell', `claude mcp add -s user tiiny -e TIINY_KEY=${K} -- ${py} ${script} mcp`,
          'The same tools, with Claude Code starting the bridge itself. The panel still has to be running.')];
      case 'claude-desktop': return [
        snippet('Claude Desktop', 'claude_desktop_config.json', json({mcpServers: {tiiny: {command: py, args: [script, 'mcp'], env: {TIINY_KEY: K}}}}),
          'In Claude Desktop: Settings → Developer → Edit Config. Then quit Claude Desktop completely and start it again. On Linux the file is ~/.config/Claude/claude_desktop_config.json.')];
      case 'cursor': return [
        snippet('Cursor', '~/.cursor/mcp.json', json({mcpServers: {tiiny: {url: `${B}/mcp`, headers: {Authorization: `Bearer ${K}`}}}}),
          'For one project only, put it in .cursor/mcp.json in that project instead.')];
      case 'openclaw': return [
        snippet('OpenClaw', '~/.openclaw/openclaw.json', `{\n  models: {\n    providers: {\n      tiiny: {\n        baseUrl: "${B}/v1",\n        apiKey: "${K}",\n        api: "openai-completions",\n        models: [{ id: "${M}" }],\n      },\n    },\n  },\n  agents: { defaults: { model: { primary: "tiiny/${M}" } } },\n  mcp: {\n    servers: {\n      tiiny: { url: "${B}/mcp", transport: "streamable-http", headers: { Authorization: "Bearer ${K}" } },\n    },\n  },\n}`,
          'Merge these into your openclaw.json: OpenClaw won’t start with keys it doesn’t know. The models part makes a Tiiny model OpenClaw’s model; the mcp part adds the Tiiny’s tools.')];
      case 'hermes': return [
        snippet('Hermes Agent: the Tiiny’s tools', '~/.hermes/config.yaml', `mcp_servers:\n  tiiny:\n    url: "${B}/mcp"\n    headers:\n      Authorization: "Bearer ${K}"`,
          'Then run /reload-mcp in Hermes, or start it again.'),
        snippet('Hermes Agent: a Tiiny model', 'shell', 'hermes model', `Choose “Custom endpoint”, then enter the base URL ${B}/v1, the API key ${K} and the model ${M}.`)];
      case 'open-webui': return [
        snippet('Open WebUI', 'Docker', `docker run -d --network=host \\\n  -e OPENAI_API_BASE_URL=${B}/v1 \\\n  -e OPENAI_API_KEY=${K} \\\n  -v open-webui:/app/backend/data --name open-webui \\\n  ghcr.io/open-webui/open-webui:main`,
          'With --network=host it reaches the panel on this computer; Open WebUI then opens at http://127.0.0.1:8080. In a running Open WebUI: Settings → Connections → OpenAI API, with the same address and key.')];
      case 'continue': return [snippet('Continue', 'config.yaml', `models:\n  - name: Tiiny ${shortName(M)}\n    provider: openai\n    model: ${M}\n    apiBase: ${B}/v1\n    apiKey: ${K}\n    roles: [chat, edit, apply]`, 'In ~/.continue/config.yaml.')];
      case 'zed': return [snippet('Zed', 'settings.json', json({language_models: {openai_compatible: {Tiiny: {api_url: `${B}/v1`, available_models: [{name: M, max_tokens: 32768}]}}}}),
        'Zed asks for the API key (your app key) the first time you pick the provider.')];
      case 'aider': return [snippet('aider', 'shell', `export OPENAI_API_BASE=${B}/v1\nexport OPENAI_API_KEY=${K}\naider --model openai/${M}`)];
      case 'llm': return [snippet('llm (Simon Willison’s CLI)', 'extra-openai-models.yaml', `- model_id: tiiny\n  model_name: ${M}\n  api_base: "${B}/v1"\n  api_key_name: tiiny`,
        `Put this in the file shown by: dirname "$(llm logs path)"; then run: llm keys set tiiny (paste the key), and llm -m tiiny "Hello!"`)];
      case 'obsidian': return [snippet('Obsidian Copilot', 'settings', `Settings → Copilot → Model → Add custom model\n  Model name: ${M}\n  Provider:   OpenAI Format\n  Base URL:   ${B}/v1\n  API key:    ${K}`)];
      case 'ollama-app': return [snippet('Apps made for Ollama', 'settings', `Ollama server address:  ${B}\nAPI key (if the app asks):  ${K}`,
        'Enchanted, Msty, Page Assist and other Ollama apps. If an app can’t send a key, switch on “Ollama apps without a key” above.')];
      default: return [
        snippet('OpenAI SDK', 'Python', `from openai import OpenAI\n\nclient = OpenAI(base_url="${B}/v1", api_key="${K}")\nreply = client.chat.completions.create(\n    model="${M}",\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(reply.choices[0].message.content)`),
        snippet('OpenAI SDK', 'JavaScript / TypeScript', `import OpenAI from "openai";\n\nconst client = new OpenAI({ baseURL: "${B}/v1", apiKey: "${K}" });\nconst reply = await client.chat.completions.create({\n  model: "${M}",\n  messages: [{ role: "user", content: "Hello!" }],\n});\nconsole.log(reply.choices[0].message.content);`),
        snippet('curl', 'shell', `curl ${B}/v1/chat/completions \\\n  -H "Authorization: Bearer ${K}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${M}", "messages": [{"role": "user", "content": "Hello!"}]}'`),
        snippet('Anthropic SDK', 'Python', `import anthropic\n\nclient = anthropic.Anthropic(base_url="${B}", api_key="${K}")\nreply = client.messages.create(\n    model="${M}",\n    max_tokens=1024,\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(reply.content[0].text)`),
        snippet('Ollama', 'Python', `from ollama import Client\n\nclient = Client(host="${B}", headers={"Authorization": "Bearer ${K}"})\nprint(client.chat(model="${M}", messages=[{"role": "user", "content": "Hello!"}]).message.content)`),
        snippet('LangChain', 'Python', `from langchain_openai import ChatOpenAI\n\nllm = ChatOpenAI(base_url="${B}/v1", api_key="${K}", model="${M}")\nprint(llm.invoke("Hello!").content)`),
        snippet('LlamaIndex', 'Python', `from llama_index.llms.openai_like import OpenAILike\n\nllm = OpenAILike(api_base="${B}/v1", api_key="${K}", model="${M}", is_chat_model=True)\nprint(llm.complete("Hello!"))`)];
    }
  }
  function render() {
    const K = 'YOUR_APP_KEY';
    const group = (title, ic, items) => card({title, ic}, h('div', {class: 'snippets'}, items));
    clear(out).append(
      remote ? null : h('p', {class: 'small muted'}, 'The setups below use YOUR_APP_KEY: put in the key of the app you added above. “default” means whichever chat model is loaded; a model that isn’t loaded loads when the app asks for it.'),
      group('AI assistants (MCP)', 'spark', [...setupsFor('claude-code', K), ...setupsFor('claude-desktop', K), ...setupsFor('cursor', K)]),
      group('Agents', 'bolt', [...setupsFor('openclaw', K), ...setupsFor('hermes', K)]),
      group('Code', 'terminal', setupsFor('custom', K)),
      group('Chat apps', 'chat', [...setupsFor('open-webui', K), ...setupsFor('obsidian', K), ...setupsFor('ollama-app', K)]),
      group('Editors and coding agents', 'edit', [...setupsFor('continue', K), ...setupsFor('zed', K), ...setupsFor('aider', K), ...setupsFor('llm', K)]),
      group('Decision models (System One)', 'spark', decisionSnippets(K)));
  }
  /* Decision models (KnowLine, d3): typed questions in, a probability for every answer out. */
  const decisionModel = () => (modelsOf('decide').find(m => S.running.has(m.id)) || modelsOf('decide')[0])?.id || 'PelaAI/KnowLine-4B-Gen5.5';
  function decisionSnippets(K) {
    const D = decisionModel(), B = G();
    const body = `{
    "model": "${D}",
    "state": "Customer message: I was charged twice and want my money back.",
    "questions": {
` +
      `      "team": {"type": "choice", "instructions": "Which team should handle this?", "criteria": {"billing": "payments and refunds", "shipping": "delivery and tracking", "other": "anything else"}},
` +
      `      "angry": {"type": "noul", "instructions": "Is the customer upset?"},
` +
      `      "urgency": {"type": "score", "instructions": "How urgent is it?", "criteria": ["low", "medium", "high"]}
    }
  }`;
    return [
      snippet('curl', 'shell', `curl ${B}/v1/systemone \\
  -H "Authorization: Bearer ${K}" \\
  -H "Content-Type: application/json" \\
  -d '${body}'`,
        'Decision models answer with a probability for every option instead of writing text: "noul" is yes/no, "choice" picks one, "score" rates on a scale (lowest first). Up to 64 questions per request; add "images": ["data:image/png;base64,…"] to ask about a picture. The app needs the Decisions scope.'),
      snippet('Python', 'requests', `import requests

r = requests.post(
    "${B}/v1/systemone",
    headers={"Authorization": "Bearer ${K}"},
    json=${body},
)
for name, answer in r.json()["answers"].items():
    print(name, answer)`,
        'Each answer has the probabilities, plus "choice" (the most likely option), "noul" (the chance of yes) or "score" (the expected level, 0 = lowest).'),
    ];
  }
  const ready = () => { fillModels(); load(); };
  if (!S.modelsAt) refreshModels().then(() => { if (ctx.alive()) ready(); }); else ready();
  ctx.on('running', () => { fillModels(); });
  ctx.every(30000, () => { if (st && !document.hidden) load(); });
}

registerView({id: 'integrations', order: 82, group: 'device', title: 'Integrations', ic: 'link', sub: 'Use your Tiiny from other apps, AI assistants and your own code', render: viewIntegrations});
