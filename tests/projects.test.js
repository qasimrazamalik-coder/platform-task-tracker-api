const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, reset, makeUser, makeProject, makeTask, move, close } = require('./helpers');

before(reset);
after(close);

describe('auth', () => {
  test('register, log in, and see unread notifications count', async () => {
    const reg = await api().post('/api/auth/register').send({ name: 'Zara Ali', handle: 'Zara', email: 'zara@x.io', password: 'longenough' });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.handle, 'zara');
    const dup = await api().post('/api/auth/register').send({ name: 'Other', handle: 'zara', email: 'z2@x.io', password: 'longenough' });
    assert.equal(dup.body.error.code, 'HANDLE_TAKEN');
    const login = await api().post('/api/auth/login').send({ email: 'ZARA@x.io', password: 'longenough' });
    const me = await api().get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`);
    assert.equal(me.body.unreadNotifications, 0);
  });
});

describe('projects and membership', () => {
  test('creator becomes owner; keys are validated and unique', async () => {
    const owner = await makeUser();
    const res = await api().post('/api/projects').set(owner.auth).send({ key: 'plat', name: 'Platform' });
    assert.equal(res.status, 201);
    assert.equal(res.body.key, 'PLAT');
    assert.equal(res.body.myRole, 'owner');
    assert.equal((await api().post('/api/projects').set(owner.auth).send({ key: 'PLAT', name: 'Again' })).body.error.code, 'KEY_TAKEN');
    assert.equal((await api().post('/api/projects').set(owner.auth).send({ key: 'P1', name: 'Bad' })).status, 400);
  });

  test('outsiders get 404, not 403, so they cannot discover projects', async () => {
    const owner = await makeUser();
    const outsider = await makeUser();
    const key = await makeProject(owner);
    assert.equal((await api().get(`/api/projects/${key}`).set(outsider.auth)).status, 404);
    assert.equal((await api().get(`/api/projects/${key}/tasks`).set(outsider.auth)).status, 404);
  });

  test('maintainers add members but only owners add maintainers', async () => {
    const [owner, maint, newbie, other] = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser()]);
    const key = await makeProject(owner, [[maint, 'maintainer']]);
    const ok = await api().post(`/api/projects/${key}/members`).set(maint.auth).send({ handle: newbie.handle, role: 'member' });
    assert.equal(ok.status, 201);
    const no = await api().post(`/api/projects/${key}/members`).set(maint.auth).send({ handle: other.handle, role: 'maintainer' });
    assert.equal(no.status, 403);
    const dup = await api().post(`/api/projects/${key}/members`).set(owner.auth).send({ handle: newbie.handle, role: 'viewer' });
    assert.equal(dup.body.error.code, 'ALREADY_MEMBER');
  });

  test('a project always keeps an owner', async () => {
    const owner = await makeUser();
    const key = await makeProject(owner);
    const demote = await api().patch(`/api/projects/${key}/members/${owner.handle}`).set(owner.auth).send({ role: 'member' });
    assert.equal(demote.body.error.code, 'LAST_OWNER');
    const leave = await api().delete(`/api/projects/${key}/members/${owner.handle}`).set(owner.auth);
    assert.equal(leave.body.error.code, 'LAST_OWNER');
  });

  test("removing someone sends their open work back to the pool", async () => {
    const [owner, dev] = await Promise.all([makeUser(), makeUser()]);
    const key = await makeProject(owner, [[dev, 'member']]);
    const t = await makeTask(owner, key, { assignee: dev.handle, status: 'todo' });
    await move(dev, key, t.number, 'in_progress');
    assert.equal((await api().delete(`/api/projects/${key}/members/${dev.handle}`).set(owner.auth)).status, 204);
    const after = await api().get(`/api/projects/${key}/tasks/${t.number}`).set(owner.auth);
    assert.equal(after.body.assignee, null);
    assert.equal(after.body.status, 'todo');
  });

  test('activity feed pages with a keyset cursor', async () => {
    const owner = await makeUser();
    const key = await makeProject(owner);
    for (let i = 0; i < 5; i++) await makeTask(owner, key, { title: `t${i}` });
    const first = await api().get(`/api/projects/${key}/activity`).query({ limit: 3 }).set(owner.auth);
    assert.equal(first.body.items.length, 3);
    const second = await api().get(`/api/projects/${key}/activity`).query({ limit: 3, before: first.body.nextBefore }).set(owner.auth);
    assert.equal(second.body.items.length, 3); // 2 task events + project_created
    const ids = [...first.body.items, ...second.body.items].map((a) => a.id);
    assert.equal(new Set(ids).size, 6);
  });
});
