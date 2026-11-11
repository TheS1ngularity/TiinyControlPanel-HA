/* Gallery: every image, song, 3D model and video made on the device, kept on this computer. */
'use strict';

const GalleryAPI = {
  list: async kind => (await api(`/api/gallery${kind ? `?kind=${kind}` : ''}`)).items,
  get: id => api(`/api/gallery/${id}`),
  add: spec => api('/api/gallery', {method: 'POST', body: spec}),
  update: (id, patch) => api(`/api/gallery/${id}`, {method: 'PATCH', body: patch}),
  remove: id => api(`/api/gallery/${id}`, {method: 'DELETE', body: {}}),
  removeMany: ids => api('/api/gallery/delete', {method: 'POST', body: {ids}}),
  favoriteMany: (ids, favorite) => api('/api/gallery/favorite', {method: 'POST', body: {ids, favorite}}),
  fileUrl: (id, name, download = false) => `/api/gallery/${id}/files/${encodeURIComponent(name)}?token=${encodeURIComponent(TOKEN)}${download ? '&download=1' : ''}`,
};
const GKIND = {
  image: {label: 'Images', one: 'Image', ic: 'image', noun: ['image', 'images']},
  audio: {label: 'Music', one: 'Song', ic: 'music', noun: ['song', 'songs']},
  model3d: {label: '3D', one: '3D model', ic: 'cube', noun: ['3D model', '3D models']},
  video: {label: 'Video', one: 'Video', ic: 'film', noun: ['video', 'videos']},
};
/* Picture tags from a decision model (tiinyui/studio.py GALLERY_TAGS, System → Decision models). */
const GTAGS = {people: 'People', animals: 'Animals', nature: 'Nature', food: 'Food', buildings: 'Buildings', vehicles: 'Vehicles', text: 'Text', art: 'Art'};
/* "3 images", "1 song", "5 items" */
function gCount(list) {
  const kinds = new Set(list.map(it => it.kind));
  const [one, many] = (kinds.size === 1 && GKIND[[...kinds][0]]?.noun) || ['item', 'items'];
  return `${list.length} ${list.length === 1 ? one : many}`;
}
const gFile = (item, role = 'main') => (item.files || []).find(f => f.role === role);
const gUrl = (item, role = 'main', download = false) => { const f = gFile(item, role); return f ? GalleryAPI.fileUrl(item.id, f.name, download) : null; };
/* Hand-offs between pages ("Edit this", "Make 3D", "Use in chat") */
const Handoff = {image: null};

let modelViewerReady = null;
function ensureModelViewer() {
  if (customElements.get('model-viewer')) return Promise.resolve();
  if (!modelViewerReady) {
    modelViewerReady = new Promise((resolve, reject) => {
      const s = h('script', {type: 'module', src: '/static/vendor/model-viewer/model-viewer.min.js'});
      s.onerror = () => { modelViewerReady = null; reject(new Error('The 3D viewer couldn’t be loaded')); };
      document.head.append(s);
      customElements.whenDefined('model-viewer').then(resolve);
    });
  }
  return modelViewerReady;
}
function modelViewer(src, {poster, alt = '3D model', height = '420px'} = {}) {
  const box = h('div', {class: 'mv-box', style: {height}}, loadingBlock('Loading the 3D viewer…'));
  ensureModelViewer().then(() => {
    const mv = document.createElement('model-viewer');
    mv.setAttribute('src', src);
    mv.setAttribute('alt', alt);
    mv.setAttribute('camera-controls', '');
    mv.setAttribute('auto-rotate', '');
    mv.setAttribute('shadow-intensity', '0.8');
    mv.setAttribute('exposure', '1');
    mv.setAttribute('interaction-prompt', 'none');
    if (poster) mv.setAttribute('poster', poster);
    const status = h('div', {class: 'mv-status small muted'}, h('span', {class: 'spinner'}), 'Loading the model…');
    mv.addEventListener('progress', e => { const p = e.detail?.totalProgress; if (p >= 1) status.remove(); else status.lastChild.textContent = `Loading the model… ${Math.round((p || 0) * 100)}%`; });
    mv.addEventListener('error', () => { clear(status).append(icon('alert'), 'This model couldn’t be shown here. Download it and open it in a 3D app.'); });
    clear(box).append(mv, status);
  }).catch(e => clear(box).append(errorBlock(e.message)));
  return box;
}

/* Small JPEG thumbnail for the grid, uploaded so the gallery can keep it next to the image. */
async function makeThumb(src, max = 384) {
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('thumbnail')); i.src = src; });
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = h('canvas', {width: Math.max(1, Math.round(img.naturalWidth * scale)), height: Math.max(1, Math.round(img.naturalHeight * scale))});
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  return {blob, width: img.naturalWidth, height: img.naturalHeight};
}

/* Save something the device made. spec: {kind, file_id, src?, prompt, model, params, source, title} */
async function galleryAdd(spec) {
  try {
    const files = [{file_id: spec.file_id, role: 'main'}];
    let dims = {};
    if (spec.kind === 'image') {
      try {
        const t = await makeThumb(spec.src || `/api/file/${spec.file_id}?token=${encodeURIComponent(TOKEN)}`);
        const up = await uploadFile(t.blob, null, 'thumb.jpg');
        files.push({file_id: up.id, role: 'thumb', name: 'thumb.jpg'});
        dims = {width: t.width, height: t.height};
      } catch { /* no thumbnail; the grid shows the image itself */ }
    }
    const rec = await GalleryAPI.add({kind: spec.kind, files, title: spec.title, prompt: spec.prompt, negative_prompt: spec.negative_prompt,
      model: spec.model, params: spec.params || {}, source: spec.source || 'playground', parent_id: spec.parent_id, ...dims});
    emit('gallery', rec);
    return rec;
  } catch (e) {
    toast('Couldn’t save to the gallery', 'err', {detail: e.message});
    return null;
  }
}

/* An image as a data URL (for chat and image editing hand-offs). */
async function urlToDataUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return readAs(await r.blob(), 'dataurl');
}

/* selectable: the tile gets a tick mark (the Gallery page), and onOpen(item, event) decides between opening and marking. */
function galleryTile(item, onOpen, {selectable = false} = {}) {
  const k = GKIND[item.kind] || GKIND.image;
  let media;
  if (item.kind === 'image') media = h('img', {src: gUrl(item, 'thumb') || gUrl(item), alt: item.title || 'image', loading: 'lazy'});
  else if (item.kind === 'model3d') {
    const poster = gUrl(item, 'input');
    media = h('div', {class: 'g-ph'}, poster ? h('img', {src: poster, alt: '', loading: 'lazy'}) : icon('cube'), h('span', {class: 'g-badge'}, icon('cube'), '3D'));
  } else if (item.kind === 'video') {
    media = h('div', {class: 'g-ph'}, h('video', {src: `${gUrl(item)}#t=0.5`, preload: 'metadata', muted: true}), h('span', {class: 'g-badge'}, icon('film'), item.duration ? fmtSecs(item.duration) : 'Video'));
  } else {
    media = h('div', {class: 'g-ph audio'}, icon('music'), h('span', {class: 'g-badge'}, icon('music'), item.duration ? fmtSecs(item.duration) : 'Audio'));
  }
  return h('button', {class: 'g-tile', type: 'button', title: item.prompt || item.title || '', dataset: {id: item.id}, onclick: e => onOpen(item, e)},
    h('div', {class: 'g-media'}, media, item.favorite ? h('span', {class: 'g-fav'}, icon('star')) : null,
      selectable ? h('span', {class: 'g-check', title: 'Select'}, icon('check')) : null),
    h('div', {class: 'g-cap'}, h('span', {class: 'ellipsis'}, item.title || k.one), h('span', {class: 'faint'}, fmtAgo(item.created))));
}

/* Small pictures of what's about to be deleted. */
function gThumbStrip(list, max = 8) {
  return h('div', {class: 'g-strip'}, list.slice(0, max).map(it => {
    const src = it.kind === 'image' ? gUrl(it, 'thumb') || gUrl(it) : it.kind === 'model3d' ? gUrl(it, 'input') : null;
    return h('span', {class: 'g-strip-item', title: it.title || ''}, src ? h('img', {src, alt: it.title || ''}) : icon(GKIND[it.kind]?.ic || 'file'));
  }), list.length > max ? h('span', {class: 'g-strip-more'}, `+${list.length - max}`) : null);
}

function galleryViewer(item, {list = [], onChange} = {}) {
  let cur = item;
  const m = modal({title: cur.title || 'Item', size: 'xwide', body: h('div'), onClose: () => document.removeEventListener('keydown', onKey)});
  const onKey = e => {
    if (e.target.closest('input, textarea')) return;
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  };
  document.addEventListener('keydown', onKey);
  function step(d) {
    const i = list.findIndex(x => x.id === cur.id);
    const next = list[i + d];
    if (next) { cur = next; render(); }
  }
  function render() {
    m.setTitle(cur.title || GKIND[cur.kind]?.one || 'Item');
    const media = h('div', {class: 'g-view-media'});
    if (cur.kind === 'image') media.append(h('img', {src: gUrl(cur), alt: cur.title || 'image', class: 'result-img'}));
    else if (cur.kind === 'video') media.append(h('video', {src: gUrl(cur), controls: true, autoplay: true, loop: true, style: {width: '100%', maxHeight: '70vh'}}));
    else if (cur.kind === 'model3d') media.append(modelViewer(gUrl(cur), {poster: gUrl(cur, 'input'), alt: cur.title, height: '62vh'}));
    else {
      media.append(h('div', {class: 'g-audio'}, icon('music'), h('strong', {}, cur.title),
        h('audio', {src: gUrl(cur), controls: true, autoplay: true, style: {width: '100%'}}),
        (cur.files || []).filter(f => !['main', 'mp3'].includes(f.role) && /\.wav$/i.test(f.name)).map(f =>
          h('div', {class: 'stack-sm', style: {width: '100%'}}, h('span', {class: 'small muted'}, f.role === 'vocal' ? 'Vocals only' : f.role === 'bgm' ? 'Accompaniment only' : f.role),
            h('audio', {src: GalleryAPI.fileUrl(cur.id, f.name), controls: true, preload: 'none', style: {width: '100%'}})))));
    }
    const p = cur.params || {};
    const details = [['Made with', cur.model ? shortName(cur.model) : null], ['Created', fmtAgo(cur.created)],
      ['Size', cur.width && cur.height ? `${cur.width} × ${cur.height}` : null], ['Length', cur.duration ? fmtSecs(cur.duration) : null],
      ['Took', p.seconds_taken ? fmtSecs(p.seconds_taken) : null], ['Seed', p.seed ?? p.config?.seed ?? p.options?.seed ?? null],
      ['Steps', p.steps ?? p.config?.steps ?? null], ['From', cur.source === 'agent' ? 'Agent mode in chat' : cur.source === 'studio' ? 'Studio' : cur.source === 'playground' ? 'Playground' : cur.source],
      ['Tags', (cur.tags || []).map(t => GTAGS[t] || t).join(', ') || null]];
    const actions = [];
    if (cur.kind === 'image') {
      actions.push(btn('Edit this', async () => { Handoff.image = {mode: 'edit', refs: [await urlToDataUrl(gUrl(cur))], prompt: '', parent: cur.id}; m.close(); sessionStorage.setItem('tiiny.pgTab', 'image'); go('playground'); }, {icon: 'edit'}),
        btn('Use in chat', async () => { ChatUI.draftImages = [await urlToDataUrl(gUrl(cur))]; m.close(); go('chat'); }, {icon: 'chat'}),
        btn('Make 3D', () => { m.close(); go(`studio/3d?from=${cur.id}`); }, {icon: 'cube'}),
        btn('Animate', () => { m.close(); go(`studio/video?from=${cur.id}`); }, {icon: 'film'}));
    }
    if (cur.kind === 'audio' && p.mode === 'preview' && p.session_id && !p.resumed) {
      actions.push(btn('Continue to the full song', () => { m.close(); go(`studio/music?resume=${cur.id}`); }, {icon: 'music', kind: 'primary'}));
    }
    if (cur.kind === 'model3d' && gFile(cur, 'input')) actions.push(btn('Open the source image', () => {
      modal({title: 'Source image', size: 'wide', body: h('img', {src: gUrl(cur, 'input'), class: 'result-img', alt: 'source image'})});
    }, {icon: 'image', kind: 'ghost'}));
    const downloads = (cur.files || []).filter(f => f.role !== 'thumb').map(f => h('a', {class: 'btn sm', href: GalleryAPI.fileUrl(cur.id, f.name, true), download: f.name},
      icon('download'), f.role === 'main' ? `Download ${f.name.split('.').pop().toUpperCase()}` : f.role === 'mp3' ? 'MP3' : f.name, h('span', {class: 'faint'}, fmtBytes(f.size))));
    const fav = btn(cur.favorite ? 'Favorite' : 'Add to favorites', async () => {
      cur = {...cur, ...(await GalleryAPI.update(cur.id, {favorite: !cur.favorite}))}; render(); onChange && onChange();
    }, {icon: 'star', small: true, kind: cur.favorite ? 'primary' : 'ghost'});
    const i = list.findIndex(x => x.id === cur.id);
    clear(m.body).append(h('div', {class: 'g-view'},
      h('div', {class: 'g-view-main'}, media,
        list.length > 1 ? h('div', {class: 'row', style: {justifyContent: 'space-between'}},
          btn('Previous', () => step(-1), {small: true, kind: 'ghost', icon: 'chevronLeft', disabled: i <= 0}),
          h('span', {class: 'faint small'}, `${i + 1} of ${list.length}`),
          btn('Next', () => step(1), {small: true, kind: 'ghost', icon: 'chevron', disabled: i >= list.length - 1})) : null),
      h('div', {class: 'g-view-side stack'},
        cur.prompt ? h('div', {class: 'stack-sm'}, h('div', {class: 'section-title'}, 'Prompt'), h('p', {class: 'g-prompt'}, cur.prompt),
          h('div', {}, btn('Copy prompt', () => copyText(cur.prompt, 'Prompt copied'), {small: true, kind: 'ghost', icon: 'copy'}))) : null,
        p.config?.lyrics ? h('details', {}, h('summary', {class: 'small'}, 'Lyrics'), h('pre', {class: 'g-lyrics'}, p.config.lyrics)) : null,
        (p.notes || []).length ? h('div', {class: 'banner warn small'}, icon('info'), h('div', {class: 'text'}, p.notes.join(' '))) : null,
        kvList(details),
        actions.length ? h('div', {class: 'row wrap gap-sm'}, actions) : null,
        h('div', {class: 'row wrap gap-sm'}, downloads),
        h('div', {class: 'row wrap gap-sm'}, fav,
          btn('Rename', async () => {
            const v = await formDialog({title: 'Rename', fields: [{name: 'title', label: 'Name', value: cur.title || '', required: true, maxlength: 200}]});
            if (!v) return;
            cur = {...cur, ...(await GalleryAPI.update(cur.id, {title: v.title}))}; render(); onChange && onChange();
          }, {small: true, kind: 'ghost', icon: 'edit'}),
          btn('Delete', async () => {
            if (!(await confirmDialog({title: 'Delete this from the gallery?', message: 'The file is deleted from this computer.', confirmLabel: 'Delete', danger: true}))) return;
            await GalleryAPI.remove(cur.id);
            const idx = list.findIndex(x => x.id === cur.id);
            list.splice(idx, 1);
            onChange && onChange();
            if (list.length) { cur = list[Math.min(idx, list.length - 1)]; render(); } else m.close();
          }, {small: true, kind: 'ghost', icon: 'trash'})))));
  }
  render();
  return m;
}

function viewGallery(root, ctx) {
  let kind = ctx.query.get('kind') || sessionStorage.getItem('tiiny.galleryKind') || '';
  let q = '';
  let favOnly = false;
  let tagF = '';
  let items = null;
  let tagging = null;   // the "Tag pictures" job while it runs
  const tagRow = h('div', {class: 'row wrap gap-sm g-tags'});
  /* Selecting: mark several items, then delete them or add them to your favorites in one go. Only items on screen
     stay marked, so a search or filter never hides something that's about to be deleted. */
  let selecting = false, anchor = null, deleting = false, shown = [];
  const picked = new Set();  // ids
  const tiles = new Map();   // id → tile
  const grid = h('div', {}, loadingBlock());
  const seg = segmented([['', 'All'], ...Object.entries(GKIND).map(([k, v]) => [k, v.label])], kind, v => { kind = v; sessionStorage.setItem('tiiny.galleryKind', v); render(); });
  const favChk = h('input', {type: 'checkbox', onchange: e => { favOnly = e.target.checked; render(); }});
  const selectBtn = btn('Select', () => setSelecting(!selecting), {icon: 'check', small: true, kind: 'ghost',
    title: 'Mark several items to delete them or add them to your favorites. Shift-click marks everything in between.'});
  const countEl = h('strong', {class: 'g-selcount', 'aria-live': 'polite'});
  const allBtn = btn('Select all', () => {
    if (shown.every(it => picked.has(it.id))) picked.clear(); else for (const it of shown) picked.add(it.id);
    paintAll();
  }, {small: true, kind: 'ghost'});
  const favBtn = btn('Add to favorites', favoriteSelected, {small: true, icon: 'star'});
  const delBtn = btn('Delete', deleteSelected, {small: true, kind: 'danger', icon: 'trash'});
  const bar = h('div', {class: 'g-selbar', role: 'group', 'aria-label': 'Selected items', hidden: true},
    iconBtn('x', 'Stop selecting', () => setSelecting(false)), countEl, allBtn, h('span', {class: 'spacer'}), favBtn, delBtn);
  root.append(h('div', {class: 'toolbar'}, seg, searchBox('Search prompts and names…', v => { q = v.toLowerCase(); render(); }),
    h('label', {class: 'check small'}, favChk, h('span', {}, 'Favorites only')),
    h('div', {class: 'toolbar-end'}, selectBtn, linkBtn('Studio', '#/studio', {ic: 'music'}), linkBtn('Make an image', '#/playground', {ic: 'image'}))), tagRow, grid, bar);

  const filtered = () => (items || []).filter(it => (!kind || it.kind === kind) && (!favOnly || it.favorite) && (!tagF || (it.tags || []).includes(tagF))
    && (!q || `${it.title} ${it.prompt} ${it.model}`.toLowerCase().includes(q)));
  function renderTags() {
    clear(tagRow);
    const pics = (items || []).filter(it => it.kind === 'image');
    const counts = {};
    for (const it of pics) for (const t of it.tags || []) counts[t] = (counts[t] || 0) + 1;
    const untagged = pics.filter(it => !Array.isArray(it.tags)).length;
    const canTag = decisionOn('gallery_tags') && (untagged > 0 || tagging);
    if (tagF && !counts[tagF]) tagF = '';
    tagRow.hidden = !Object.keys(counts).length && !canTag;
    if (tagRow.hidden) return;
    const chip = (key, label, n) => h('button', {type: 'button', class: `chip${tagF === key ? ' active' : ''}`, onclick: () => { tagF = key; render(); }},
      label, n != null ? h('span', {class: 'n'}, String(n)) : null);
    append(tagRow, [Object.keys(counts).length ? [chip('', 'All tags'), Object.keys(GTAGS).filter(t => counts[t]).map(t => chip(t, GTAGS[t], counts[t]))] : [],
      h('span', {class: 'spacer'}),
      canTag ? btn(tagging ? tagging.message || 'Tagging…' : `Tag ${untagged} picture${untagged === 1 ? '' : 's'}`, tagPictures,
        {small: true, kind: 'ghost', icon: 'spark', disabled: !!tagging, title: 'A decision model looks at each picture and tags it (people, animals, nature, food, …)'}) : null]);
  }
  async function tagPictures() {
    const job = await api('/api/gallery/tag', {method: 'POST', body: {}});
    tagging = job;
    renderTags();
    const ac = new AbortController();
    ctx.onCleanup(() => ac.abort());
    const fin = await followJob(job.id, j => { tagging = j; if (ctx.alive()) renderTags(); }, {signal: ac.signal});
    tagging = null;
    if (fin?.status === 'failed') toast('Couldn’t tag the pictures', 'err', {detail: fin.error});
    else if (fin) toast(fin.message || 'Pictures tagged', 'ok', {timeout: 2500});
    if (ctx.alive()) load();
  }
  function render() {
    if (!items) return;
    const counts = Object.fromEntries(Object.keys(GKIND).map(k => [k, items.filter(i => i.kind === k).length]));
    seg.set(kind, [['', 'All', items.length], ...Object.entries(GKIND).map(([k, v]) => [k, v.label, counts[k]])]);
    renderTags();
    clear(grid);
    tiles.clear();
    shown = filtered();
    const onScreen = new Set(shown.map(it => it.id));
    for (const id of picked) if (!onScreen.has(id)) picked.delete(id);
    selectBtn.disabled = !items.length;
    if (!items.length) {
      if (selecting) setSelecting(false);
      grid.append(card({}, emptyState('grid', 'Nothing here yet', 'Images from the Playground, songs, 3D models and videos from the Studio, and pictures made in chat all appear here.',
        linkBtn('Make an image', '#/playground', {ic: 'image', kind: 'primary'}), linkBtn('Open the Studio', '#/studio', {ic: 'music'}))));
      return;
    }
    if (!shown.length) grid.append(h('p', {class: 'muted'}, 'Nothing matches.'));
    else grid.append(h('div', {class: 'g-grid can-select'}, shown.map(it => { const t = galleryTile(it, onTile, {selectable: true}); tiles.set(it.id, t); return t; })));
    paintAll();
  }
  function open(it) { galleryViewer(it, {list: filtered(), onChange: () => load()}); }

  /* A click opens the item, or marks it while selecting. The tick mark, Ctrl- or ⌘-click and Shift-click start selecting. */
  function onTile(it, e) {
    if (!selecting && !(e && (e.shiftKey || e.ctrlKey || e.metaKey || e.target.closest('.g-check')))) return open(it);
    if (!selecting) setSelecting(true);
    const i = shown.findIndex(x => x.id === it.id);
    const a = e?.shiftKey && anchor ? shown.findIndex(x => x.id === anchor) : -1;
    if (a >= 0 && i >= 0) for (const x of shown.slice(Math.min(a, i), Math.max(a, i) + 1)) picked.add(x.id);
    else if (picked.has(it.id)) picked.delete(it.id);
    else picked.add(it.id);
    anchor = it.id;
    paintAll();
  }
  function setSelecting(on) {
    selecting = on;
    if (!on) { picked.clear(); anchor = null; }
    selectBtn.setAttribute('aria-pressed', String(on));
    selectBtn.lastChild.textContent = on ? 'Done' : 'Select';
    bar.hidden = !on;
    paintAll();
  }
  function paintAll() {
    grid.querySelector('.g-grid')?.classList.toggle('selecting', selecting);
    for (const [id, t] of tiles) {
      t.classList.toggle('selected', picked.has(id));
      if (selecting) t.setAttribute('aria-pressed', String(picked.has(id))); else t.removeAttribute('aria-pressed');
      t.querySelector('.g-check').title = picked.has(id) ? 'Unselect' : 'Select';
    }
    const sel = shown.filter(it => picked.has(it.id));
    countEl.textContent = sel.length ? `${sel.length} selected` : 'Nothing selected';
    allBtn.lastChild.textContent = shown.length && sel.length === shown.length ? 'Unselect all' : `Select all (${shown.length})`;
    allBtn.disabled = !shown.length;
    favBtn.lastChild.textContent = sel.length && sel.every(it => it.favorite) ? 'Remove from favorites' : 'Add to favorites';
    favBtn.disabled = delBtn.disabled = !sel.length;
  }
  async function favoriteSelected() {
    const sel = shown.filter(it => picked.has(it.id));
    if (!sel.length) return;
    const fav = !sel.every(it => it.favorite);
    await GalleryAPI.favoriteMany(sel.map(it => it.id), fav);
    toast(fav ? `Added ${gCount(sel)} to your favorites` : `Removed ${gCount(sel)} from your favorites`, 'ok', {timeout: 2500});
    await load();
  }
  async function deleteSelected() {
    const sel = shown.filter(it => picked.has(it.id));
    if (!sel.length || deleting) return;
    deleting = true;
    try {
      const what = gCount(sel);
      const favs = sel.filter(it => it.favorite).length;
      const ok = await confirmDialog({title: `Delete ${what}?`, confirmLabel: `Delete ${what}`, danger: true, message: h('div', {class: 'stack-sm'},
        gThumbStrip(sel),
        h('p', {}, `${sel.length === 1 ? 'Its' : 'Their'} files are deleted from this computer too. This can’t be undone.`),
        favs ? h('p', {class: 'small muted g-strip-note'}, icon('star'),
          sel.length === 1 ? 'It’s one of your favorites.' : favs === 1 ? '1 of them is in your favorites.' : `${favs} of them are in your favorites.`) : null)});
      if (!ok) return;
      const res = await GalleryAPI.removeMany(sel.map(it => it.id));
      setSelecting(false);
      toast(`Deleted ${gCount(sel.filter(it => !res.missing.includes(it.id)))}`, 'ok');
      await load();
    } finally { deleting = false; }
  }
  const onKey = e => {
    if (!selecting || $('#modal-root').childElementCount || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'Escape') { e.preventDefault(); setSelecting(false); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); for (const it of shown) picked.add(it.id); paintAll(); }
    else if (e.key === 'Delete' || (e.key === 'Backspace' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      deleteSelected().catch(err => toast(err.message || String(err), 'err'));
    }
  };
  document.addEventListener('keydown', onKey);
  ctx.onCleanup(() => document.removeEventListener('keydown', onKey));
  async function load() {
    try { items = await GalleryAPI.list(); }
    catch (e) { clear(grid).append(errorBlock(e.message, {retry: load})); return; }
    if (ctx.alive()) render();
  }
  ctx.on('gallery', load);
  load().then(() => { const id = ctx.query.get('open'); const it = id && items?.find(x => x.id === id); if (it) open(it); });
}

/* Pick an image from the gallery (for editing, 3D and video). Resolves to an item or null. */
function galleryPicker({kind = 'image', title = 'Choose from the gallery'} = {}) {
  return new Promise(resolve => {
    let done = false;
    const body = h('div', {}, loadingBlock());
    const m = modal({title, size: 'wide', body, onClose: () => { if (!done) resolve(null); }});
    GalleryAPI.list(kind).then(list => {
      clear(body);
      if (!list.length) { body.append(emptyState('image', 'No images yet', 'Make one in the Playground first.')); return; }
      body.append(h('div', {class: 'g-grid small'}, list.map(it => galleryTile(it, () => { done = true; m.close(); resolve(it); }))));
    }).catch(e => clear(body).append(errorBlock(e.message)));
  });
}

registerView({id: 'gallery', order: 62, group: 'create', title: 'Gallery', ic: 'grid', sub: 'Everything your Tiiny made, saved on this computer', render: viewGallery});
