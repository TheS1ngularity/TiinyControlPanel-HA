/* Install as an app: service worker, install button, desktop notifications, app menu entry. */
'use strict';

const PWA = {prompt: null, installed: window.matchMedia?.('(display-mode: standalone)').matches || false};
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* not available here; the panel works without it */ });
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); PWA.prompt = e; emit('pwa'); });
window.addEventListener('appinstalled', () => { PWA.prompt = null; PWA.installed = true; emit('pwa'); toast('Installed. Open it from your app launcher.', 'ok'); });

function appCard(ctx) {
  const body = h('div', {class: 'stack'});
  async function render() {
    let menu = null;
    try { menu = await api('/api/launcher'); } catch { /* older server */ }
    if (!ctx.alive()) return;
    const notif = 'Notification' in window ? Notification.permission : 'unsupported';
    const rows = [];
    if (PWA.installed) rows.push(h('div', {class: 'row'}, icon('check'), h('span', {}, 'You’re using the installed app.')));
    else if (PWA.prompt) rows.push(h('div', {class: 'row wrap'}, btn('Install the app', async () => { PWA.prompt.prompt(); await PWA.prompt.userChoice.catch(() => null); PWA.prompt = null; render(); }, {kind: 'primary', icon: 'download'}),
      h('span', {class: 'small muted'}, 'Opens in its own window with its own icon, like any other app.')));
    else rows.push(h('p', {class: 'small muted'}, `To install it as an app, use your browser’s menu: “Install Tiiny Control Panel…” in Chrome or Edge (Firefox doesn’t install web apps)${onServer() ? '. Browsers only install apps from secure (HTTPS) addresses.' : '. The app still needs this panel running on this computer.'}`));
    rows.push(h('div', {class: 'row wrap'},
      notif === 'granted' ? h('span', {class: 'row gap-sm'}, icon('check'), 'Notifications are on: long tasks tell you when they finish while the window is in the background.')
        : notif === 'denied' ? h('span', {class: 'small muted'}, 'Notifications are blocked for this page in your browser’s site settings.')
          : notif === 'unsupported' ? h('span', {class: 'small muted'}, 'This browser can’t show notifications.')
            : btn('Turn on notifications', async () => { await Notification.requestPermission(); render(); if (Notification.permission === 'granted') notify('Notifications are on', 'You’ll hear from the panel when long tasks finish.', {force: true}); }, {icon: 'info'})));
    if (menu?.supported) {
      rows.push(h('div', {class: 'row wrap'},
        menu.installed ? btn('Remove from the app menu', async () => { await api('/api/launcher', {method: 'POST', body: {installed: false}}); toast('Removed from the app menu', 'ok'); render(); }, {kind: 'ghost', icon: 'x'})
          : btn('Add to the app menu', async () => { await api('/api/launcher', {method: 'POST', body: {installed: true}}); toast('Added: look for “Tiiny Control Panel” in your app menu', 'ok'); render(); }, {icon: 'plus'}),
        h('span', {class: 'small muted'}, menu.installed ? 'Starting it from the menu opens the panel (or the window that’s already running).' : 'Start the panel from your desktop’s app menu, without a terminal.')));
    }
    if (onServer()) {   // it runs as a service there: stopping it from a page would leave no way to start it again
      rows.push(h('p', {class: 'small muted'}, S.health?.container ? 'It runs as a service on the server. To restart it, run docker compose restart there.'
        : 'It runs on the server. Restart it there, for example with the service that starts it.'));
      append(clear(body), rows);
      return;
    }
    rows.push(h('div', {class: 'row wrap'}, btn('Stop the panel', async () => {
      if (!(await confirmDialog({title: 'Stop the Tiiny Control Panel?', message: 'The panel’s server on this computer shuts down and this page stops working until you start it again. Your Tiiny keeps running.', confirmLabel: 'Stop it', danger: true}))) return;
      await api('/api/shutdown', {method: 'POST', body: {}});
      document.body.replaceChildren(h('div', {class: 'stopped-page'}, h('h1', {}, 'The panel has stopped'), h('p', {}, 'Start it again from your app menu or with python3 tiiny_ui.py.')));
    }, {kind: 'ghost', icon: 'power'}), h('span', {class: 'small muted'}, 'Shuts down the panel’s server on this computer. Background work (reviews, studio renders) stops too.')));
    append(clear(body), rows);
  }
  render();
  ctx.on('pwa', render);
  return card({title: 'App and notifications', ic: 'monitor'}, body);
}
