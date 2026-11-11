/* Use the panel from a phone: a local-network listener that only paired devices can use. */
'use strict';

function qrSvg(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), m = 4, size = n + m * 2;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'qr');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code with the pairing link');
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', size); bg.setAttribute('height', size); bg.setAttribute('fill', '#ffffff');
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m},${r + m}h1v1h-1z`;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d); path.setAttribute('fill', '#000000');
  svg.append(bg, path);
  return svg;
}

/* Server mode (tiiny_ui.py --server): every device signs in once with a one-time link, with full or limited access
   (tiinyui/pairing.py). The first link comes from the server's log or `python3 tiiny_ui.py pair`; more are made here. */
function serverDevicesCard(ctx) {
  if (S.health?.remote) return card({title: 'Devices', icon: 'phone', sub: 'Who can use this panel'},
    h('p', {class: 'small muted'}, 'This device has limited access. A device with full access can add or remove devices.'));
  const body = h('div', {class: 'stack'}, loadingBlock());
  let timer = null, role = 'limited';
  ctx.onCleanup(() => clearInterval(timer));
  async function load() {
    let st;
    try { st = await api('/api/lan'); } catch (e) { clear(body).append(errorBlock(e.message)); return; }
    if (ctx.alive()) render(st);
  }
  function render(st) {
    clearInterval(timer);
    const pairBox = h('div');
    const ROLE = {owner: 'Full access', limited: 'Limited'};
    const rows = [h('p', {class: 'small muted'}, 'Every device signs in once, with a link that works one time. Full access can do everything, including ' +
      'settings, app keys, backups and the terminal. Limited access is for phones and other people: chats, the Vault, pictures and the device, but nothing ' +
      'that changes the panel or reaches into the server.')];
    if (!st.tls) rows.push(h('div', {class: 'banner warn'}, icon('alert'), h('div', {class: 'text small'}, h('strong', {}, 'Not encrypted'),
      'HTTPS is switched off (TIINY_UI_TLS=off), so devices reach the panel over plain HTTP and the microphone only works on the ' +
      'server itself. Use it on a network you trust, or switch HTTPS back on.')));
    else if (st.tls_info?.own) rows.push(ownCertNote('each device'));
    rows.push(h('div', {class: 'row wrap gap-sm'}, segmented([['limited', 'Limited (phones)'], ['owner', 'Full access']], role, v => { role = v; }),
      btn('Add a device', async () => {
        const p = await api('/api/lan/pair', {method: 'POST', body: {role}});
        let left = p.expires_in;
        const count = h('span', {class: 'small muted'});
        const tick = () => { count.textContent = left > 0 ? `This link works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} more.` : 'This link has expired.'; left--; };
        tick();
        clearInterval(timer);
        timer = setInterval(() => { tick(); if (left < -1) { clearInterval(timer); clear(pairBox); } }, 1000);
        clear(pairBox).append(h('div', {class: 'pair-box'}, typeof qrcode === 'function' ? qrSvg(p.url) : null,
          h('div', {class: 'stack-sm'}, h('strong', {}, `Scan this with the device’s camera (${ROLE[p.role].toLowerCase()})`),
            h('span', {class: 'small muted'}, 'Or open this link on it:'), h('code', {class: 'pair-url'}, p.url), count,
            h('div', {}, btn('Done', () => { clearInterval(timer); clear(pairBox); load(); }, {small: true, kind: 'ghost'})))));
      }, {kind: 'primary', icon: 'plus'})), pairBox);
    rows.push(h('div', {class: 'stack-sm'}, h('div', {class: 'section-title'}, 'Signed-in devices'), st.devices.map(d => h('div', {class: 'row'},
      icon('phone'), h('div', {class: 'spacer', style: {minWidth: 0}},
        h('div', {class: 'row gap-sm wrap'}, h('strong', {}, d.name), badge(ROLE[d.role] || d.role, d.role === 'owner' ? 'accent' : ''), d.id === st.me ? badge('This device', 'ok') : null),
        h('div', {class: 'cell-sub'}, `Signed in ${fmtAgo(d.created)} · last seen ${fmtAgo(d.last_seen)}${d.ip ? ` · ${d.ip}` : ''}`)),
      btn('Remove', async () => {
        const me = d.id === st.me;
        if (!(await confirmDialog({title: `Remove ${d.name}?`, danger: true, confirmLabel: 'Remove',
          message: me ? 'This is the device you’re using. It’s signed out at once, and needs a new link to come back.' : 'It’s signed out at once, and needs a new link to come back.'}))) return;
        await api(`/api/lan/devices/${d.id}`, {method: 'DELETE', body: {}});
        if (me) location.reload(); else load();
      }, {small: true, kind: 'ghost', icon: 'trash'})))));
    append(clear(body), rows);
  }
  load();
  return card({title: 'Devices', icon: 'phone', sub: 'Who can use this panel'}, body);
}

function devicesCard(ctx) {
  if (onServer()) return serverDevicesCard(ctx);
  const body = h('div', {class: 'stack'}, loadingBlock());
  let pairTimer = null;
  ctx.onCleanup(() => clearInterval(pairTimer));
  async function load() {
    let st;
    try { st = await api('/api/lan'); } catch (e) { clear(body).append(errorBlock(e.message)); return; }
    if (ctx.alive()) render(st);
  }
  async function setEnabled(on) {
    try { render(await api('/api/lan', {method: 'POST', body: {enabled: on}})); }
    catch (e) { toast('Couldn’t change that', 'err', {detail: e.message}); load(); }
  }
  function render(st) {
    clearInterval(pairTimer);
    const port = st.port || location.port || '8765';
    const rows = [h('div', {class: 'row gap-sm'}, switchInput(st.enabled && st.running, setEnabled, 'Allow paired devices on your network'),
      h('span', {class: 'spacer'}, 'Allow paired phones and tablets on your network'))];
    if (st.error) rows.push(h('div', {class: 'banner warn'}, icon('alert'), h('div', {class: 'text small'}, st.error)));
    if (!st.running) {
      rows.push(h('p', {class: 'small muted'}, 'When this is on, the panel also listens on this computer’s local-network address. Only devices you pair with a QR code can use it; everything else gets a “not paired” page.'));
    } else {
      const pairBox = h('div');
      if (!st.tls) rows.push(h('div', {class: 'banner warn'}, icon('alert'), h('div', {class: 'text small'},
        h('strong', {}, 'Only on a network you trust'),
        'Phones connect without encryption (plain HTTP), because HTTPS is switched off (--no-tls). Anyone who can see your Wi-Fi traffic could take over a paired phone’s connection, and phones can’t use the microphone.')));
      else if (st.tls_info?.own) rows.push(ownCertNote('the phone'));
      rows.push(h('div', {class: 'stack-sm'},
        h('div', {class: 'small'}, 'Address on your network: ', h('code', {}, st.url)),
        h('div', {class: 'row wrap gap-sm'}, btn('Pair a phone', async () => {
          const p = await api('/api/lan/pair', {method: 'POST', body: {}});
          let left = p.expires_in;
          const count = h('span', {class: 'small muted'});
          const tick = () => { count.textContent = left > 0 ? `This code works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} more.` : 'This code has expired.'; left--; };
          tick();
          clearInterval(pairTimer);
          pairTimer = setInterval(() => { tick(); if (left < -1) { clearInterval(pairTimer); clear(pairBox); } }, 1000);
          clear(pairBox).append(h('div', {class: 'pair-box'}, typeof qrcode === 'function' ? qrSvg(p.url) : null,
            h('div', {class: 'stack-sm'}, h('strong', {}, 'Scan this with the phone’s camera'),
              h('span', {class: 'small muted'}, 'The phone must be on the same network as this computer. Or open this link on it:'),
              h('code', {class: 'pair-url'}, p.url), count,
              h('div', {}, btn('Done', () => { clearInterval(pairTimer); clear(pairBox); load(); }, {small: true, kind: 'ghost'})))));
        }, {kind: 'primary', icon: 'phone'})), pairBox));
      rows.push(h('details', {class: 'small'}, h('summary', {}, 'The phone can’t connect?'),
        h('div', {class: 'stack-sm'}, h('p', {}, 'Check that both are on the same Wi-Fi. If this computer’s firewall blocks the port, allow it.'),
          h('p', {class: 'muted'}, 'Fedora, openSUSE and others with firewalld (add --permanent to keep it after a restart):'),
          h('code', {class: 'block'}, `sudo firewall-cmd --add-port=${port}/tcp`),
          h('p', {class: 'muted'}, 'Ubuntu, Debian, Mint and others with ufw:'),
          h('code', {class: 'block'}, `sudo ufw allow ${port}/tcp`),
          h('p', {class: 'muted'}, 'Arch has no firewall switched on unless you set one up.'),
          st.tls ? h('p', {class: 'muted'}, 'The phone shows a warning about the connection the first time: that’s the panel’s own certificate. Choose Advanced, then Continue.')
            : h('p', {class: 'muted'}, 'Browsers only allow the microphone on secure pages, so recording meetings from a phone needs HTTPS, which is switched off (--no-tls).'))));
    }
    if (st.devices.length) {
      rows.push(h('div', {class: 'stack-sm'}, h('div', {class: 'section-title'}, 'Paired devices'), st.devices.map(d => h('div', {class: 'row'},
        icon('phone'), h('div', {class: 'spacer', style: {minWidth: 0}}, h('strong', {}, d.name), h('div', {class: 'cell-sub'}, `Paired ${fmtAgo(d.created)} · last seen ${fmtAgo(d.last_seen)}${d.ip ? ` · ${d.ip}` : ''}`)),
        btn('Remove', async () => {
          if (!(await confirmDialog({title: `Remove ${d.name}?`, message: 'It can’t use the panel any more until you pair it again.', confirmLabel: 'Remove', danger: true}))) return;
          await api(`/api/lan/devices/${d.id}`, {method: 'DELETE', body: {}});
          load();
        }, {small: true, kind: 'ghost', icon: 'trash'})))));
    }
    append(clear(body), rows);
  }
  load();
  return card({title: 'Phone and other devices', ic: 'phone', sub: 'Use the panel from your phone on the same network'}, body);
}


/* HTTPS with the panel's own certificate (tiinyui/tlscert.py): what the one-time browser warning is, before anyone
   is surprised by it. */
function ownCertNote(who) {
  return h('div', {class: 'banner info'}, icon('shield'), h('div', {class: 'text small'}, h('strong', {}, 'Encrypted'),
    `The panel made its own certificate, so ${who === 'the phone' ? 'a phone' : 'each device'}’s browser warns once the first time: ` +
    'choose Advanced, then Continue. That’s expected; after that the connection is encrypted and the microphone works. ' +
    'Your own certificate or Tailscale avoids the warning (see the user guide).'));
}
