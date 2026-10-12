// Platform frontend: plain JavaScript, no build step. All rules live on the server;
// the UI only shows the moves the API says you can make (allowedTransitions).

const $ = (id) => document.getElementById(id);
const store = {
  get token() { try { return localStorage.getItem('pf.token'); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem('pf.token', v) : localStorage.removeItem('pf.token'); } catch {} },
};
let me = null;
let projects = [];
let state = { key: null, filter: 'all', q: '', lastFlip: null };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDay = (d) => d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
const ago = (t) => {
  const m = Math.round((Date.now() - new Date(t)) / 60000);
  if (m < 60) return `${Math.max(m, 1)} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
};

const LABEL = { backlog: 'BACKLOG', todo: 'TO DO', in_progress: 'STARTED', blocked: 'BLOCKED', in_review: 'REVIEW', done: 'DONE' };
const VERB = {
  'backlog>todo': 'Move to to-do', 'todo>backlog': 'Back to backlog', 'todo>in_progress': 'Start work',
  'in_progress>in_review': 'Send for review', 'in_progress>blocked': 'Mark blocked', 'in_progress>todo': 'Stop work',
  'blocked>in_progress': 'Unblock', 'in_review>done': 'Approve', 'in_review>in_progress': 'Request changes', 'done>todo': 'Reopen',
};
const DONE_MSG = { in_progress: 'Started', in_review: 'Sent for review', done: 'Approved', blocked: 'Marked blocked', todo: 'Moved to to-do', backlog: 'Moved to backlog' };

function flap(status, animate) {
  const letters = LABEL[status].padEnd(7, ' ').split('');
  return `<span class="flap s-${status}${animate ? ' flip' : ''}" aria-label="${LABEL[status]}">${letters
    .map((ch, i) => `<span style="--i:${i}" aria-hidden="true">${ch === ' ' ? '&nbsp;' : esc(ch)}</span>`).join('')}</span>`;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(store.token ? { Authorization: `Bearer ${store.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && store.token) { store.token = null; me = null; route(); }
  if (!res.ok) {
    const e = new Error(data.error?.message || 'Request failed');
    e.code = data.error?.code; e.details = data.error?.details;
    throw e;
  }
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3200);
}

// ---------- header ----------
function drawStation() {
  const p = projects.find((x) => x.key === state.key);
  $('station').innerHTML = `
    <div class="name">${p ? esc(p.name) : 'Platform'}${p ? `<small>${esc(p.key)}</small>` : ''}</div>
    <div class="clock" id="clock"></div>
    ${me ? `<div class="who">
      <button class="bell" id="bell" aria-label="Notifications">Inbox${me.unreadNotifications ? `<b>${me.unreadNotifications}</b>` : ''}</button>
      <span>@${esc(me.handle)}${p ? `, ${esc(p.myRole)}` : ''}</span>
      <button id="out">Sign out</button></div>` : ''}`;
  tick();
  if (!me) return;
  $('out').onclick = () => { store.token = null; me = null; location.hash = ''; route(); };
  $('bell').onclick = openInbox;
}
function tick() {
  const c = $('clock');
  if (c) c.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
setInterval(tick, 30000);

async function openInbox() {
  const existing = document.querySelector('.inbox');
  if (existing) return existing.remove();
  const items = await api('/notifications');
  const box = document.createElement('div');
  box.className = 'inbox';
  box.innerHTML = `<ul>${items.map((n) => `<li class="${n.readAt ? '' : 'unread'}">${esc(n.message)}<div class="sub" style="color:var(--muted);font-size:.78rem">${ago(n.createdAt)}</div></li>`).join('')
    || '<li>Nothing yet. Mentions, reviews and assignments land here.</li>'}</ul>
    ${items.some((n) => !n.readAt) ? '<div class="foot"><button class="btn ghost" id="readall">Mark all read</button></div>' : ''}`;
  document.body.appendChild(box);
  const ra = box.querySelector('#readall');
  if (ra) ra.onclick = async () => { await api('/notifications/read', { method: 'POST', body: {} }); me.unreadNotifications = 0; box.remove(); drawStation(); };
}

// ---------- project list ----------
async function drawLines() {
  projects = await api('/projects');
  $('lines').innerHTML = `<h2>Your projects</h2>
    ${projects.map((p) => `<a href="#/${p.key}" ${p.key === state.key ? 'aria-current="page"' : ''}>
      <span class="badge">${esc(p.key)}</span><span>${esc(p.name)}</span><span class="count">${p.openTasks}</span></a>`).join('')}
    <form id="newProject">
      <h2 style="margin:0">New project</h2>
      <input id="npKey" placeholder="KEY, e.g. WEB" maxlength="6" required>
      <input id="npName" placeholder="Name" required>
      <button class="btn ghost">Create</button>
    </form>`;
  $('newProject').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const p = await api('/projects', { method: 'POST', body: { key: $('npKey').value, name: $('npName').value } });
      location.hash = `#/${p.key}`;
    } catch (ex) { toast(ex.details ? ex.details.map((d) => d.message).join(' ') : ex.message, true); }
  };
}

// ---------- sign in ----------
function viewSignin() {
  $('lines').innerHTML = '';
  drawStation();
  $('view').innerHTML = `
    <div class="signin">
      <header><h1 style="font-size:1.3rem">Sign in to Platform</h1><p>Your team's work, read like a departures board.</p></header>
      <form id="f">
        <div><label for="email">Email</label><input id="email" type="email" autocomplete="email" required></div>
        <div><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></div>
        <button class="btn">Sign in</button>
        <p class="err" id="err" hidden></p>
      </form>
      <p class="demo">Demo team, password <b>password123</b>:
        <button data-u="sana">Sana (owner)</button>, <button data-u="omar">Omar (maintainer)</button>,
        <button data-u="hamza">Hamza (member)</button>, <button data-u="rehan">Rehan (viewer)</button>.</p>
    </div>`;
  document.querySelectorAll('[data-u]').forEach((b) => (b.onclick = () => {
    $('email').value = `${b.dataset.u}@platform.test`; $('pw').value = 'password123';
  }));
  $('f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email: $('email').value, password: $('pw').value } });
      store.token = r.token;
      route();
    } catch (ex) { $('err').textContent = ex.message; $('err').hidden = false; }
  };
}

// ---------- board ----------
async function viewBoard() {
  const p = projects.find((x) => x.key === state.key);
  if (!p) {
    $('view').innerHTML = `<p class="empty">You are not on any projects yet. Create one on the left, or ask a teammate to add @${esc(me.handle)}.</p>`;
    return;
  }
  const params = new URLSearchParams();
  if (state.filter === 'mine') params.set('assignee', 'me');
  if (state.filter === 'overdue') params.set('overdue', 'true');
  if (state.q) params.set('q', state.q);
  const [tasks, metrics, detail] = await Promise.all([
    api(`/projects/${p.key}/tasks?${params}`), api(`/projects/${p.key}/metrics`), api(`/projects/${p.key}`),
  ]);
  const canWrite = p.myRole !== 'viewer';
  const maxThroughput = Math.max(1, ...metrics.throughput.map((w) => w.done));

  $('view').innerHTML = `
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Filter">
        ${[['all', 'All'], ['mine', 'Mine'], ['overdue', 'Overdue']].map(([k, l]) =>
          `<button data-filter="${k}" aria-pressed="${state.filter === k}">${l}</button>`).join('')}
      </div>
      <input id="q" placeholder="Find by title or ${esc(p.key)}-12" value="${esc(state.q)}" aria-label="Search tasks">
      ${canWrite ? '<button class="btn" id="newTask">New task</button>' : ''}
    </div>
    <form id="taskForm" class="metrics" hidden style="align-items:center">
      <input id="ntTitle" placeholder="What needs doing?" style="flex:2;min-width:200px" required>
      <select id="ntWho" style="flex:1;min-width:140px"><option value="">Unassigned</option>
        ${detail.members.filter((m) => m.role !== 'viewer').map((m) => `<option value="${esc(m.handle)}">@${esc(m.handle)}</option>`).join('')}</select>
      <input id="ntDue" type="date" style="flex:1;min-width:140px" aria-label="Due date">
      <button class="btn">Add task</button>
    </form>
    <div class="metrics">
      <div><div class="bars" title="Tasks finished per week, last 8 weeks">${metrics.throughput.map((w) =>
        `<span style="height:${Math.round((w.done / maxThroughput) * 100)}%" title="${w.week}: ${w.done}"></span>`).join('')}</div>Finished per week</div>
      <div><strong>${metrics.cycleTime.medianHours == null ? 'n/a' : `${(metrics.cycleTime.medianHours / 24).toFixed(1)} days`}</strong>Typical start to done</div>
      <div><strong>${metrics.overdue}</strong>Overdue</div>
      <div><div class="wipdots">${metrics.wip.people.map((w) =>
        `<span title="${w.in_progress} of ${metrics.wip.limit} in progress">@${esc(w.handle)} ${'<i class="on"></i>'.repeat(Math.min(w.in_progress, metrics.wip.limit))}${'<i></i>'.repeat(Math.max(0, metrics.wip.limit - w.in_progress))}</span>`).join('')}</div>
        In progress, limit ${metrics.wip.limit} each</div>
    </div>
    ${tasks.length ? `<table class="board">
      <thead><tr><th>No.</th><th>Task</th><th class="hide-sm">Who</th><th>Status</th><th class="hide-sm">Due</th><th class="hide-sm">Waiting on</th></tr></thead>
      <tbody>${tasks.map((t) => `
        <tr class="row prio-${t.priority}" data-n="${t.number}" tabindex="0">
          <td class="ref">${esc(t.ref)}</td>
          <td><div class="title">${esc(t.title)}</div>${t.commentCount ? `<div class="sub">${t.commentCount} comment${t.commentCount === 1 ? '' : 's'}</div>` : ''}</td>
          <td class="hide-sm">${t.assignee ? `@${esc(t.assignee.handle)}` : '<span class="sub">Anyone</span>'}</td>
          <td>${flap(t.status, state.lastFlip === t.ref)}</td>
          <td class="hide-sm due ${t.overdue ? 'late' : ''}">${t.overdue ? `Late, ${fmtDay(t.dueDate)}` : fmtDay(t.dueDate)}</td>
          <td class="hide-sm gate">${t.openDependencies ? `${t.openDependencies} task${t.openDependencies === 1 ? '' : 's'}` : ''}</td>
        </tr>`).join('')}</tbody></table>`
      : `<div class="board empty">${state.filter === 'all' && !state.q ? 'No tasks yet. Add the first one.' : 'Nothing matches this filter.'}</div>`}`;
  // Bring the row that just changed into view so its flip is seen.
  document.querySelector('.flap.flip')?.closest('tr')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  state.lastFlip = null;

  document.querySelectorAll('[data-filter]').forEach((b) => (b.onclick = () => { state.filter = b.dataset.filter; viewBoard(); }));
  let deb;
  $('q').oninput = (e) => { clearTimeout(deb); deb = setTimeout(() => { state.q = e.target.value; viewBoard().then(() => $('q').focus()); }, 250); };
  const tbody = document.querySelector('.board tbody');
  if (tbody) {
    tbody.onclick = (e) => { const r = e.target.closest('tr.row'); if (r) openTask(r.dataset.n); };
    tbody.onkeydown = (e) => { if (e.key === 'Enter') { const r = e.target.closest('tr.row'); if (r) openTask(r.dataset.n); } };
  }
  if (canWrite) {
    $('newTask').onclick = () => { $('taskForm').hidden = !$('taskForm').hidden; $('ntTitle').focus(); };
    $('taskForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const t = await api(`/projects/${p.key}/tasks`, { method: 'POST', body: {
          title: $('ntTitle').value, status: 'todo',
          ...($('ntWho').value ? { assignee: $('ntWho').value } : {}),
          ...($('ntDue').value ? { dueDate: $('ntDue').value } : {}),
        } });
        toast(`Added ${t.ref}.`);
        state.lastFlip = t.ref;
        await drawLines(); viewBoard();
      } catch (ex) { toast(ex.message, true); }
    };
  }
}

// ---------- task drawer ----------
async function openTask(number) {
  const key = state.key;
  const t = await api(`/projects/${key}/tasks/${number}`);
  const p = projects.find((x) => x.key === key);
  const detail = await api(`/projects/${key}`);
  document.querySelector('.drawer-bg')?.remove();
  const bg = document.createElement('div');
  bg.className = 'drawer-bg';
  const withMentions = (s) => esc(s).replace(/(^|[^a-z0-9_])@([a-z0-9_]{2,24})/gi, '$1<span class="mention">@$2</span>');
  const canWrite = p.myRole !== 'viewer';
  bg.innerHTML = `
    <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="dt">
      <header><button class="close" id="x">Close</button>
        <div class="ref">${esc(t.ref)}</div><h2 id="dt">${esc(t.title)}</h2></header>
      <div class="body">
        <div>${flap(t.status)}</div>
        <div>
          <h3>Next step</h3>
          <div class="moves">${t.allowedTransitions.map((to) =>
            `<button class="btn ${to === 'done' || to === 'in_progress' || to === 'in_review' ? '' : 'ghost'}" data-to="${to}">${VERB[`${t.status}>${to}`]}</button>`).join('')
            || `<span class="why">${p.myRole === 'viewer' ? 'Viewers can follow along but not move tasks.' : 'You have no moves on this task right now.'}</span>`}</div>
          ${t.openDependencies && t.status === 'todo' ? `<p class="why" style="margin-top:8px">Waiting on ${t.openDependencies} task${t.openDependencies === 1 ? '' : 's'} below before it can start.</p>` : ''}
        </div>
        <form id="edit" class="facts">
          <dt>Who</dt><dd><select id="eWho" ${canWrite ? '' : 'disabled'}><option value="">Anyone</option>
            ${detail.members.filter((m) => m.role !== 'viewer').map((m) => `<option value="${esc(m.handle)}" ${t.assignee?.handle === m.handle ? 'selected' : ''}>@${esc(m.handle)}</option>`).join('')}</select></dd>
          <dt>Priority</dt><dd><select id="ePrio" ${canWrite ? '' : 'disabled'}>${['low', 'normal', 'high', 'urgent'].map((x) => `<option ${t.priority === x ? 'selected' : ''}>${x}</option>`).join('')}</select></dd>
          <dt>Due</dt><dd><input id="eDue" type="date" value="${esc(t.dueDate || '')}" ${canWrite ? '' : 'disabled'}></dd>
          <dt>Reported by</dt><dd>@${esc(t.reporter.handle)}</dd>
          ${canWrite ? '<dt></dt><dd><button class="btn ghost">Save changes</button></dd>' : ''}
        </form>
        ${t.dependsOn.length || t.blocks.length ? `<div class="deps">
          ${t.dependsOn.length ? `<h3>Waiting on</h3><ul>${t.dependsOn.map((d) => `<li><span class="ref">${esc(d.ref)}</span> ${esc(d.title)} <span class="why">(${LABEL[d.status].toLowerCase()})</span></li>`).join('')}</ul>` : ''}
          ${t.blocks.length ? `<h3 style="margin-top:12px">Holding up</h3><ul>${t.blocks.map((d) => `<li><span class="ref">${esc(d.ref)}</span> ${esc(d.title)}</li>`).join('')}</ul>` : ''}
        </div>` : ''}
        <div>
          <h3>Discussion</h3>
          <div class="comments">${t.comments.map((c) => `<div class="note"><div class="meta">@${esc(c.handle)}, ${ago(c.createdAt)}</div>${withMentions(c.body)}</div>`).join('')
            || '<p class="why">No comments yet.</p>'}</div>
          ${canWrite ? `<form id="cf" style="margin-top:10px;display:grid;gap:8px">
            <textarea id="cb" rows="3" placeholder="Write a comment. Use @handle to notify a teammate." required></textarea>
            <div><button class="btn">Post comment</button></div></form>` : ''}
        </div>
        <div class="feed"><h3>History</h3><ul>${t.activity.map((a) => `<li>@${esc(a.handle || 'system')} ${esc(describe(a))} <span class="why">${ago(a.at)}</span></li>`).join('')}</ul></div>
      </div>
    </aside>`;
  document.body.appendChild(bg);
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  bg.onclick = (e) => e.target === bg && close();
  bg.querySelector('#x').onclick = close;
  bg.querySelector('#x').focus();

  bg.querySelectorAll('[data-to]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try {
      const moved = await api(`/projects/${key}/tasks/${number}/transition`, { method: 'POST', body: { to: b.dataset.to, version: t.version } });
      close();
      toast(`${DONE_MSG[moved.status] || 'Moved'}: ${moved.ref}`);
      state.lastFlip = moved.ref;
      await drawLines();
      viewBoard();
    } catch (ex) {
      toast(ex.message, true);
      if (ex.code === 'VERSION_CONFLICT') openTask(number); else b.disabled = false;
    }
  }));
  const edit = bg.querySelector('#edit');
  if (canWrite) edit.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/projects/${key}/tasks/${number}`, { method: 'PATCH', body: {
        version: t.version, assignee: $('eWho').value || null, priority: $('ePrio').value, dueDate: $('eDue').value || null,
      } });
      toast('Saved.');
      viewBoard(); openTask(number);
    } catch (ex) {
      toast(ex.code === 'VERSION_CONFLICT' ? 'Someone changed this task while you had it open. Showing their version.' : ex.message, true);
      if (ex.code === 'VERSION_CONFLICT') openTask(number);
    }
  };
  const cf = bg.querySelector('#cf');
  if (cf) cf.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const c = await api(`/projects/${key}/tasks/${number}/comments`, { method: 'POST', body: { body: $('cb').value } });
      toast(c.mentioned ? `Posted. ${c.mentioned} teammate${c.mentioned === 1 ? '' : 's'} notified.` : 'Posted.');
      openTask(number);
    } catch (ex) { toast(ex.message, true); }
  };
}

function describe(a) {
  switch (a.kind) {
    case 'created': return 'created the task';
    case 'status': return `moved it from ${LABEL[a.from]?.toLowerCase() || a.from} to ${LABEL[a.to]?.toLowerCase() || a.to}`;
    case 'assigned': return 'changed who it is assigned to';
    case 'edited': return `edited ${a.to}`;
    case 'commented': return 'commented';
    case 'dependency_added': return `made it wait on ${a.to}`;
    case 'dependency_removed': return `removed the wait on ${a.from}`;
    default: return a.kind.replace(/_/g, ' ');
  }
}

// ---------- router ----------
async function route() {
  document.querySelector('.inbox')?.remove();
  if (!store.token) return viewSignin();
  try {
    me = await api('/auth/me');
    await drawLines();
    const wanted = location.hash.replace(/^#\//, '').toUpperCase();
    state.key = projects.some((p) => p.key === wanted) ? wanted : projects[0]?.key ?? null;
    drawLines();
    drawStation();
    await viewBoard();
  } catch (ex) {
    if (!store.token) return;
    $('view').innerHTML = `<p class="empty">Couldn't load the board: ${esc(ex.message)} Check the server is running, then reload.</p>`;
  }
}
window.addEventListener('hashchange', () => { state.filter = 'all'; state.q = ''; route(); });
route();
