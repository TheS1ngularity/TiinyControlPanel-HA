/* Saved work on the panel server (chats, projects…), shared by every browser and phone you pair. */
'use strict';

const Store = {
  async list(coll, fields, query = {}) {
    const qs = new URLSearchParams({fields: (fields || []).join(','), ...query});
    return (await api(`/api/store/${coll}?${qs}`)).items;
  },
  get: (coll, id) => api(`/api/store/${coll}/${encodeURIComponent(id)}`),
  put: (coll, rec) => api(`/api/store/${coll}/${encodeURIComponent(rec.id)}`, {method: 'PUT', body: rec}),
  create: (coll, rec) => api(`/api/store/${coll}`, {method: 'POST', body: rec}),
  del: (coll, id) => api(`/api/store/${coll}/${encodeURIComponent(id)}`, {method: 'DELETE', body: {}}),
};

const ProjectsAPI = {
  list: async () => (await api('/api/projects')).projects,
  get: id => api(`/api/projects/${id}`),
  create: body => api('/api/projects', {method: 'POST', body}),
  update: (id, patch) => api(`/api/projects/${id}`, {method: 'PATCH', body: patch}),
  remove: (id, chats = 'keep') => api(`/api/projects/${id}?chats=${chats}`, {method: 'DELETE', body: {}}),
  addDoc: (id, spec) => api(`/api/projects/${id}/docs`, {method: 'POST', body: spec}),
  doc: (id, did) => api(`/api/projects/${id}/docs/${did}`),
  removeDoc: (id, did) => api(`/api/projects/${id}/docs/${did}`, {method: 'DELETE', body: {}}),
  index: id => api(`/api/projects/${id}/index`, {method: 'POST', body: {}}),
  context: (id, question, start = 1) => api(`/api/projects/${id}/context`, {method: 'POST', body: {question, start}}),
  search: (id, query, k = 8) => api(`/api/projects/${id}/search`, {method: 'POST', body: {query, k}}),
  read: (id, name) => api(`/api/projects/${id}/read`, {method: 'POST', body: {name}}),
  memory: (id, body) => api(`/api/projects/${id}/memory`, {method: 'POST', body}),
};

/* Follow a background job until it finishes. onUpdate(job) is called on every change. */
function followJob(jobId, onUpdate, {signal} = {}) {
  return new Promise(resolve => {
    let last = null;
    if (signal?.aborted) { resolve(null); return; }
    const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/stream?token=${encodeURIComponent(TOKEN)}`);
    signal?.addEventListener('abort', () => { es.close(); resolve(null); });
    es.addEventListener('job', e => {
      last = JSON.parse(e.data);
      try { if (onUpdate) onUpdate(last); } catch (err) { console.error(err); }
      if (last.status !== 'running') { es.close(); resolve(last); }
    });
    es.onerror = () => {
      es.close();
      api(`/api/jobs/${encodeURIComponent(jobId)}`).then(j => {
        if (j.status !== 'running') resolve(j);
        else if (!signal?.aborted) setTimeout(() => followJob(jobId, onUpdate, {signal}).then(resolve), 1500);
        else resolve(null);
      }).catch(() => resolve(last || {status: 'failed', error: 'Lost track of the job.'}));
    };
  });
}

/* Chats used to live in this browser's storage; move them to the panel once. */
async function migrateBrowserChats() {
  let old = null;
  try { old = JSON.parse(localStorage.getItem('tiiny.chats.v2') || 'null'); } catch { old = null; }
  if (!Array.isArray(old) || !old.length) return;
  try {
    const items = old.filter(c => c && c.id).map(c => ({...c, id: String(c.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || uid(), project_id: null}));
    const r = await api('/api/store/chats/import', {method: 'POST', body: {items}});
    localStorage.setItem('tiiny.chats.v2.migrated', String(Date.now()));
    localStorage.removeItem('tiiny.chats.v2');
    if (r.imported) toast(`Moved ${r.imported} chat(s) to the panel`, 'ok', {detail: 'Chats are now saved on this computer, so other browsers and your phone see them too.'});
  } catch (e) { console.warn('Chat migration failed; will retry next time.', e); }
}
