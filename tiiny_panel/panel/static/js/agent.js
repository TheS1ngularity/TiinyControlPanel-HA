/* Agent mode's tools as the page shows them: under System → Agent tools (a switch for each) and in a reply's steps.
   The tools themselves run on the panel server, which also writes agent replies (tiinyui/agenttools.py and
   tiinyui/turns.py), so a reply carries on when the page closes. This list mirrors the server's: names, titles,
   groups, the switch they share, and how they ask (risk "read" runs without asking; anything else asks first, and
   alwaysAsk tools ask every time). */
'use strict';

/* A small JPEG copy of a picture (the playground's decision tool shows one). */
async function smallThumb(src, max = 192) {
  const img = await Promise.race([
    new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('Unsupported image')); i.src = src; }),
    sleep(5000).then(() => { throw new Error('The picture took too long to load'); })]);
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = h('canvas', {width: Math.max(1, Math.round(img.naturalWidth * k)), height: Math.max(1, Math.round(img.naturalHeight * k))});
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

const engineName = () => ({brave: 'Brave Search', searxng: 'your SearXNG'})[S.health?.settings?.search_engine] || 'DuckDuckGo';

/* Tools sharing a `toggle` (project files, history) share one switch. */
const toolKey = t => t.toggle || t.name;
const TOOL_ORDER = ['web_search', 'fetch_web_page', 'save_web_page_to_vault', 'history', 'search_vault', 'save_note_to_vault', 'project_files',
  'device_status', 'list_models', 'load_model', 'unload_model', 'generate_image', 'edit_image', 'run_command', 'find_files', 'read_file',
  'write_file', 'open_on_computer', 'get_current_time', 'calculate'];
const toolRank = t => { const i = TOOL_ORDER.indexOf(toolKey(t)); return i < 0 ? 999 : i; };
const TOOL_GROUPS = [['web', 'Web'], ['files', 'Your files and history'], ['device', 'The device'], ['make', 'Making things'],
  ['computer', 'This computer'], ['helpers', 'Small helpers']];

const PROJECT_FILES = 'Project files (search, read, list)', HISTORY = 'Search and open past chats, meetings and the Gallery';
const AgentTools = [
  {name: 'search_project_files', title: PROJECT_FILES, group: 'files', toggle: 'project_files', risk: 'read'},
  {name: 'read_project_file', title: PROJECT_FILES, group: 'files', toggle: 'project_files', risk: 'read'},
  {name: 'list_project_files', title: PROJECT_FILES, group: 'files', toggle: 'project_files', risk: 'read'},
  {name: 'search_vault', title: 'Search your Vault', group: 'files', risk: 'read'},
  {name: 'search_my_history', title: HISTORY, group: 'files', toggle: 'history', risk: 'read'},
  {name: 'open_from_history', title: HISTORY, group: 'files', toggle: 'history', risk: 'read'},
  {name: 'save_note_to_vault', title: 'Save notes to your Vault', group: 'files', risk: 'write'},
  {name: 'save_web_page_to_vault', title: 'Save web pages to your Vault', group: 'web', risk: 'write'},
  {name: 'web_search', title: 'Search the web', group: 'web', risk: 'network'},
  {name: 'fetch_web_page', title: 'Read web pages', group: 'web', risk: 'network'},
  {name: 'device_status', title: 'Check the device', group: 'device', risk: 'read'},
  {name: 'list_models', title: 'List the models', group: 'device', risk: 'read'},
  {name: 'load_model', title: 'Load models', group: 'device', risk: 'write'},
  {name: 'unload_model', title: 'Unload models', group: 'device', risk: 'write'},
  {name: 'generate_image', title: 'Make images', group: 'make', risk: 'write'},
  {name: 'edit_image', title: 'Edit images', group: 'make', risk: 'write'},
  {name: 'get_current_time', title: 'Date and time', group: 'helpers', risk: 'read'},
  {name: 'calculate', title: 'Calculator', group: 'helpers', risk: 'read'},
  {name: 'run_command', title: 'Run commands', group: 'computer', risk: 'command', alwaysAsk: true},
  {name: 'read_file', title: 'Read files', group: 'computer', risk: 'computer'},
  {name: 'write_file', title: 'Write files', group: 'computer', risk: 'file', alwaysAsk: true},
  {name: 'find_files', title: 'Find files', group: 'computer', risk: 'computer'},
  {name: 'open_on_computer', title: 'Open files and links', group: 'computer', risk: 'open', alwaysAsk: true},
];
