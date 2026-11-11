/* Home Assistant add-on shim (not part of the upstream Tiiny Control Panel).
   Inside Home Assistant the panel is served under /api/hassio_ingress/<token>/ instead of at "/".
   The panel's code asks for root paths like /api/... and /static/..., so this file adds that prefix to every
   request and link the page makes. Opened directly (http://host:8765) there is no prefix and this does nothing. */
(() => {
  'use strict';
  const m = location.pathname.match(/^(\/api\/hassio_ingress\/[^/]+)/);
  if (!m) return;
  const BASE = m[1];
  const ORIGIN = location.origin;
  const fix = u => {
    if (u instanceof URL) u = u.href;
    if (typeof u !== 'string') return u;
    if (u.startsWith(ORIGIN + '/')) u = u.slice(ORIGIN.length);
    if (u.startsWith('/') && !u.startsWith('//') && u !== BASE && !u.startsWith(BASE + '/') && !u.startsWith(BASE + '?')) return BASE + u;
    return u;
  };
  window.__haIngressBase = BASE;

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string' || input instanceof URL) input = fix(input);
    else if (input instanceof Request) { const u = fix(input.url); if (u !== input.url) input = new Request(u, input); }
    return origFetch.call(this, input, init);
  };
  const wrapCtor = name => {
    const Orig = window[name];
    if (!Orig) return;
    const Wrapped = function (url, ...rest) { return new Orig(fix(url), ...rest); };
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    window[name] = Wrapped;
  };
  ['EventSource', 'Worker', 'SharedWorker'].forEach(wrapCtor);
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { return xhrOpen.call(this, method, fix(url), ...rest); };
  if (window.AudioWorklet) {
    const add = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = function (url, opts) { return add.call(this, fix(url), opts); };
  }
  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => beacon(fix(url), data);
  }
  const origOpen = window.open;
  window.open = function (url, ...rest) { return origOpen.call(window, fix(url), ...rest); };
  // No service worker inside Home Assistant: its scope would be the whole Home Assistant address.
  if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error('Not used inside Home Assistant'));

  const URL_ATTRS = new Set(['src', 'href', 'poster', 'action']);
  const props = [['HTMLImageElement', 'src'], ['HTMLMediaElement', 'src'], ['HTMLSourceElement', 'src'], ['HTMLScriptElement', 'src'],
    ['HTMLIFrameElement', 'src'], ['HTMLEmbedElement', 'src'], ['HTMLTrackElement', 'src'], ['HTMLInputElement', 'src'],
    ['HTMLAnchorElement', 'href'], ['HTMLLinkElement', 'href'], ['HTMLVideoElement', 'poster'], ['HTMLFormElement', 'action']];
  for (const [cls, prop] of props) {
    const proto = window[cls] && window[cls].prototype;
    const d = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) continue;
    Object.defineProperty(proto, prop, {...d, set(v) { d.set.call(this, fix(v)); }});
  }
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    return setAttr.call(this, name, URL_ATTRS.has(String(name).toLowerCase()) ? fix(value) : value);
  };
  // Markup inserted as HTML text (rendered answers, for example) skips the setters above: fix it after it lands.
  const fixEl = el => {
    for (const a of URL_ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v && v.startsWith('/')) { const f = fix(v); if (f !== v) setAttr.call(el, a, f); }
    }
  };
  new MutationObserver(list => {
    for (const rec of list) {
      if (rec.type === 'attributes') fixEl(rec.target);
      else for (const n of rec.addedNodes) if (n.nodeType === 1) { fixEl(n); n.querySelectorAll('[src],[href],[poster],[action]').forEach(fixEl); }
    }
  }).observe(document.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: [...URL_ATTRS]});
})();
