const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, reset, makeUser, makeProject, makeTask, move, query, close } = require('./helpers');

before(reset);
after(close);

const url = (key, n = '') => `/api/projects/${key}/tasks${n === '' ? '' : `/${n}`}`;

describe('creating and editing', () => {
  test('RACE: ten tasks created at once get numbers 1 to 10, no gaps or duplicates', async () => {
    const owner = await makeUser();
    const key = await makeProject(owner);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      api().post(url(key)).set(owner.auth).send({ title: `Task ${i}` })));
    assert.ok(results.every((r) => r.status === 201));
    const numbers = results.map((r) => r.body.number).sort((a, b) => a - b);
    assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(results.find((r) => r.body.number === 7).body.ref, `${key}-7`);
  });

  test('assignee must be a project member who can take work', async () => {
    const [owner, viewer, stranger] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const key = await makeProject(owner, [[viewer, 'viewer']]);
    for (const h of [viewer.handle, stranger.handle]) {
      const res = await api().post(url(key)).set(owner.auth).send({ title: 'x', assignee: h });
      assert.equal(res.body.error.code, 'ASSIGNEE_NOT_MEMBER');
    }
  });

  test('optimistic locking: the second of two edits from the same version is rejected', async () => {
    const owner = await makeUser();
    const key = await makeProject(owner);
    const t = await makeTask(owner, key);
    const a = await api().patch(url(key, t.number)).set(owner.auth).send({ version: t.version, title: 'Edited in tab A' });
    assert.equal(a.status, 200);
    assert.equal(a.body.version, t.version + 1);
    const b = await api().patch(url(key, t.number)).set(owner.auth).send({ version: t.version, title: 'Edited in tab B' });
    assert.equal(b.status, 409);
    assert.equal(b.body.error.code, 'VERSION_CONFLICT');
    assert.equal(b.body.error.details.current.title, 'Edited in tab A');
  });

  test('viewers can read but not write', async () => {
    const [owner, viewer] = await Promise.all([makeUser(), makeUser()]);
    const key = await makeProject(owner, [[viewer, 'viewer']]);
    const t = await makeTask(owner, key);
    assert.equal((await api().get(url(key, t.number)).set(viewer.auth)).status, 200);
    assert.equal((await api().post(url(key)).set(viewer.auth).send({ title: 'nope' })).status, 403);
    assert.equal((await api().patch(url(key, t.number)).set(viewer.auth).send({ version: 1, title: 'nope' })).status, 403);
    assert.equal((await move(viewer, key, t.number, 'todo')).body.error.code, 'READ_ONLY');
  });
});

describe('workflow through the API', () => {
  test('a full trip: start auto-assigns, review notifies maintainers, a different maintainer approves', async () => {
    const [owner, dev] = await Promise.all([makeUser(), makeUser()]);
    const key = await makeProject(owner, [[dev, 'member']]);
    const t = await makeTask(owner, key, { status: 'todo' });

    const start = await move(dev, key, t.number, 'in_progress');
    assert.equal(start.status, 200);
    assert.equal(start.body.assignee.handle, dev.handle);
    assert.equal((await move(dev, key, t.number, 'in_review')).status, 200);
    const inbox = await api().get('/api/notifications').set(owner.auth);
    assert.ok(inbox.body.some((n) => n.kind === 'review' && n.task === `${key}-${t.number}`));

    assert.equal((await move(dev, key, t.number, 'done')).body.error.code, 'NEEDS_MAINTAINER');
    const done = await move(owner, key, t.number, 'done');
    assert.equal(done.body.status, 'done');
    assert.ok(done.body.completedAt);
    const devInbox = await api().get('/api/notifications').set(dev.auth);
    assert.ok(devInbox.body.some((n) => n.kind === 'approved'));
  });

  test('four eyes holds even for the owner reviewing their own work', async () => {
    const owner = await makeUser();
    const key = await makeProject(owner);
    const t = await makeTask(owner, key, { status: 'todo' });
    await move(owner, key, t.number, 'in_progress');
    await move(owner, key, t.number, 'in_review');
    assert.equal((await move(owner, key, t.number, 'done')).body.error.code, 'FOUR_EYES');
  });

  test("a member cannot move a teammate's task", async () => {
    const [owner, a, b] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const key = await makeProject(owner, [[a, 'member'], [b, 'member']]);
    const t = await makeTask(owner, key, { status: 'todo', assignee: a.handle });
    assert.equal((await move(b, key, t.number, 'in_progress')).body.error.code, 'NOT_YOUR_TASK');
  });

  test('stale version on a transition is rejected', async () => {
    const owner = await makeUser();
    const key = await makeProject(owner);
    const t = await makeTask(owner, key);
    await api().patch(url(key, t.number)).set(owner.auth).send({ version: t.version, priority: 'high' });
    const res = await api().post(`${url(key, t.number)}/transition`).set(owner.auth).send({ to: 'todo', version: t.version });
    assert.equal(res.body.error.code, 'VERSION_CONFLICT');
  });

  test('WIP limit stops a fourth task in progress', async () => {
    const owner = await makeUser();
    const key = await makeProject(owner, [], { wipLimit: 3 });
    const tasks = [];
    for (let i = 0; i < 4; i++) tasks.push(await makeTask(owner, key, { status: 'todo' }));
    for (const t of tasks.slice(0, 3)) assert.equal((await move(owner, key, t.number, 'in_progress')).status, 200);
    assert.equal((await move(owner, key, tasks[3].number, 'in_progress')).body.error.code, 'WIP_LIMIT');
  });

  test('RACE: six tasks started at once by one person, exactly three succeed', async () => {
    const owner = await makeUser();
    const key = await makeProject(owner, [], { wipLimit: 3 });
    const tasks = await Promise.all(Array.from({ length: 6 }, () => makeTask(owner, key, { status: 'todo' })));
    const results = await Promise.all(tasks.map((t) =>
      api().post(`${url(key, t.number)}/transition`).set(owner.auth).send({ to: 'in_progress', version: t.version })));
    assert.equal(results.filter((r) => r.status === 200).length, 3);
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.body.error.code === 'WIP_LIMIT'));
    const { rows: [n] } = await query(`SELECT count(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id
                                        WHERE p.key = $1 AND t.status = 'in_progress'`, [key]);
    assert.equal(n.n, 3);
  });

  test('handing in-progress work to someone at their limit is refused', async () => {
    const [owner, dev] = await Promise.all([makeUser(), makeUser()]);
    const key = await makeProject(owner, [[dev, 'member']], { wipLimit: 1 });
    const t1 = await makeTask(owner, key, { status: 'todo', assignee: dev.handle });
    await move(dev, key, t1.number, 'in_progress');
    const t2 = await makeTask(owner, key, { status: 'todo' });
    const started = await move(owner, key, t2.number, 'in_progress');
    const res = await api().patch(url(key, t2.number)).set(owner.auth).send({ version: started.body.version, assignee: dev.handle });
    assert.equal(res.body.error.code, 'WIP_LIMIT');
  });

  test('task detail reports which moves the caller can make', async () => {
    const [owner, dev] = await Promise.all([makeUser(), makeUser()]);
    const key = await makeProject(owner, [[dev, 'member']]);
    const t = await makeTask(owner, key, { status: 'todo', assignee: dev.handle });
    await move(dev, key, t.number, 'in_progress');
    await move(dev, key, t.number, 'in_review');
    const asDev = await api().get(url(key, t.number)).set(dev.auth);
    const asOwner = await api().get(url(key, t.number)).set(owner.auth);
    assert.deepEqual(asDev.body.allowedTransitions, ['in_progress']);
    assert.deepEqual(asOwner.body.allowedTransitions, ['done', 'in_progress']);
  });
});

describe('dependencies', () => {
  test('cannot start until what it depends on is done', async () => {
    const [owner, reviewer] = await Promise.all([makeUser(), makeUser()]);
    const key = await makeProject(owner, [[reviewer, 'maintainer']]);
    const base = await makeTask(owner, key, { title: 'Schema', status: 'todo' });
    const api1 = await makeTask(owner, key, { title: 'API on top', status: 'todo' });
    const dep = await api().post(`${url(key, api1.number)}/dependencies`).set(owner.auth).send({ dependsOn: base.number });
    assert.equal(dep.status, 201);
    assert.equal(dep.body.dependsOn[0].ref, `${key}-${base.number}`);

    assert.equal((await move(owner, key, api1.number, 'in_progress')).body.error.code, 'BLOCKED_BY_DEPENDENCIES');
    await move(owner, key, base.number, 'in_progress');
    await move(owner, key, base.number, 'in_review');
    await move(reviewer, key, base.number, 'done');
    assert.equal((await move(owner, key, api1.number, 'in_progress')).status, 200);
  });

  test('cycles are rejected, including indirect ones', async () => {
    const owner = await makeUser();
    const key = await makeProject(owner);
    const [a, b, c] = [await makeTask(owner, key), await makeTask(owner, key), await makeTask(owner, key)];
    const dep = (x, y) => api().post(`${url(key, x.number)}/dependencies`).set(owner.auth).send({ dependsOn: y.number });
    assert.equal((await dep(b, a)).status, 201); // b needs a
    assert.equal((await dep(c, b)).status, 201); // c needs b
    assert.equal((await dep(a, c)).body.error.code, 'DEPENDENCY_CYCLE'); // a needs c would loop
    assert.equal((await dep(a, a)).body.error.code, 'SELF_DEPENDENCY');
    assert.equal((await dep(b, a)).body.error.code, 'DEPENDENCY_EXISTS');
  });

  test('RACE: A->B and B->A submitted together, only one wins', async () => {
    const owner = await makeUser();
    const key = await makeProject(owner);
    const [a, b] = [await makeTask(owner, key), await makeTask(owner, key)];
    const [r1, r2] = await Promise.all([
      api().post(`${url(key, a.number)}/dependencies`).set(owner.auth).send({ dependsOn: b.number }),
      api().post(`${url(key, b.number)}/dependencies`).set(owner.auth).send({ dependsOn: a.number }),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
  });
});

describe('comments, ordering and metrics', () => {
  test('@mentions notify project members only', async () => {
    const [owner, dev, outsider] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const key = await makeProject(owner, [[dev, 'member']]);
    const t = await makeTask(owner, key);
    const res = await api().post(`${url(key, t.number)}/comments`).set(owner.auth)
      .send({ body: `@${dev.handle} can you take this? cc @${outsider.handle}, mail me at x@y.com` });
    assert.equal(res.status, 201);
    assert.equal(res.body.mentioned, 1);
    const devInbox = await api().get('/api/notifications').query({ unread: 'true' }).set(dev.auth);
    assert.equal(devInbox.body[0].kind, 'mention');
    const outsiderInbox = await api().get('/api/notifications').set(outsider.auth);
    assert.equal(outsiderInbox.body.length, 0);
    const read = await api().post('/api/notifications/read').set(dev.auth).send({});
    assert.ok(read.body.marked >= 1);
  });

  test('reordering places a task between its neighbours', async () => {
    const owner = await makeUser();
    const key = await makeProject(owner);
    const [a, b, c] = [await makeTask(owner, key), await makeTask(owner, key), await makeTask(owner, key)];
    const moved = await api().put(`${url(key, c.number)}/position`).set(owner.auth).send({ before: b.number });
    assert.ok(moved.body.position > a.position && moved.body.position < b.position);
    const list = await api().get(url(key)).query({ status: 'backlog' }).set(owner.auth);
    assert.deepEqual(list.body.map((t) => t.number), [a.number, c.number, b.number]);
  });

  test('metrics: throughput, cycle time from the activity log, and WIP per person', async () => {
    const [owner, reviewer] = await Promise.all([makeUser(), makeUser()]);
    const key = await makeProject(owner, [[reviewer, 'maintainer']]);
    const t = await makeTask(owner, key, { status: 'todo', dueDate: '2020-01-01' });
    await move(owner, key, t.number, 'in_progress');
    // Pretend work started two days ago.
    await query(`UPDATE activity SET at = now() - interval '48 hours' WHERE to_value = 'in_progress'
                  AND task_id = (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.key = $1 AND t.number = $2)`,
      [key, t.number]);
    await move(owner, key, t.number, 'in_review');
    await move(reviewer, key, t.number, 'done');
    await makeTask(owner, key, { dueDate: '2020-01-01' });

    const m = await api().get(`/api/projects/${key}/metrics`).set(owner.auth);
    assert.equal(m.status, 200);
    assert.equal(m.body.throughput.length, 8);
    assert.equal(m.body.throughput.at(-1).done, 1);
    assert.equal(m.body.cycleTime.tasks, 1);
    assert.ok(Math.abs(Number(m.body.cycleTime.avgHours) - 48) < 1);
    assert.equal(m.body.overdue, 1); // the done task no longer counts as overdue
    assert.equal(m.body.byStatus.find((s) => s.status === 'done').count, 1);
  });
});
