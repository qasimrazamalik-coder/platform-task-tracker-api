// Demo data: one team, two projects, tasks in every state, dependencies,
// comments, and eight weeks of backdated history so the metrics have shape.
// Safe to re-run: it wipes and reloads.
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const config = require('../src/config');

const people = [
  ['Sana Iqbal', 'sana'], ['Omar Farooq', 'omar'], ['Hamza Sheikh', 'hamza'],
  ['Ayesha Noor', 'ayesha'], ['Rehan Butt', 'rehan'],
];

// [title, status, assignee, priority, dueInDays|null, startedDaysAgo|null, doneDaysAgo|null]
const platTasks = [
  ['Design the database schema', 'done', 'hamza', 'high', null, 40, 36],
  ['Set up CI with test database', 'done', 'ayesha', 'normal', null, 35, 33],
  ['Login and registration endpoints', 'done', 'hamza', 'high', null, 30, 26],
  ['Password reset by email', 'done', 'ayesha', 'normal', null, 24, 19],
  ['Rate limit the login route', 'done', 'hamza', 'normal', null, 18, 17],
  ['Projects and membership API', 'done', 'ayesha', 'high', null, 15, 10],
  ['Task workflow state machine', 'done', 'hamza', 'urgent', null, 12, 6],
  ['Optimistic locking on task edits', 'in_review', 'ayesha', 'high', 2, 4, null],
  ['Dependency cycle detection', 'in_progress', 'hamza', 'high', 3, 2, null],
  ['Activity feed with keyset paging', 'in_progress', 'ayesha', 'normal', 5, 1, null],
  ['Cycle time and throughput metrics', 'todo', null, 'normal', 9, null, null],
  ['Email digest of notifications', 'blocked', 'hamza', 'low', -2, 3, null],
  ['Load test the WIP limit under contention', 'todo', 'ayesha', 'high', -1, null, null],
  ['Write the deployment runbook', 'backlog', null, 'low', null, null, null],
  ['Archive old projects', 'backlog', null, 'low', null, null, null],
  ['Dark mode for the board', 'backlog', null, 'low', null, null, null],
];

const opsTasks = [
  ['Rotate database credentials', 'todo', 'omar', 'urgent', 1, null, null],
  ['Nightly backups to object storage', 'done', 'omar', 'high', null, 20, 14],
  ['Alert when disk is 80% full', 'in_progress', 'omar', 'normal', 4, 1, null],
];

(async () => {
  const db = new Client({ connectionString: config.databaseUrl });
  await db.connect();
  await db.query('BEGIN');
  await db.query('TRUNCATE activity, notifications, comments, task_dependencies, tasks, project_members, projects, users RESTART IDENTITY CASCADE');

  const hash = await bcrypt.hash('password123', 10);
  const id = {};
  for (const [name, handle] of people) {
    const { rows: [u] } = await db.query(
      'INSERT INTO users (name, handle, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, handle, `${handle}@platform.test`, hash]);
    id[handle] = u.id;
  }

  async function project(key, name, description, members, tasks) {
    const { rows: [p] } = await db.query(
      `INSERT INTO projects (key, name, description, wip_limit, created_at) VALUES ($1, $2, $3, 3, now() - interval '60 days') RETURNING id`,
      [key, name, description]);
    for (const [handle, role] of members) {
      await db.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [p.id, id[handle], role]);
    }
    const taskIds = [];
    let n = 0;
    for (const [title, status, who, priority, due, started, done] of tasks) {
      n += 1;
      const { rows: [t] } = await db.query(
        `INSERT INTO tasks (project_id, number, title, status, priority, assignee_id, reporter_id, due_date, position,
                            completed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 CASE WHEN $8::int IS NULL THEN NULL ELSE current_date + $8::int END, $9,
                 CASE WHEN $10::int IS NULL THEN NULL ELSE now() - make_interval(days => $10::int) END,
                 now() - interval '45 days')
         RETURNING id`,
        [p.id, n, title, status, priority, who ? id[who] : null, id.sana, due, n * 1024, done]);
      taskIds.push(t.id);
      const log = (kind, from, to, daysAgo, actor) => db.query(
        `INSERT INTO activity (project_id, task_id, actor_id, kind, from_value, to_value, at)
         VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7::int))`, [p.id, t.id, actor, kind, from, to, daysAgo]);
      await log('created', null, 'backlog', 45, id.sana);
      if (started !== null) await log('status', 'todo', 'in_progress', started, who ? id[who] : id.sana);
      if (done !== null) await log('status', 'in_review', 'done', done, id.omar);
    }
    await db.query('UPDATE projects SET next_number = $2 WHERE id = $1', [p.id, n + 1]);
    return { id: p.id, taskIds };
  }

  const plat = await project('PLAT', 'Platform launch', 'The tracker you are looking at, built in the open.',
    [['sana', 'owner'], ['omar', 'maintainer'], ['hamza', 'member'], ['ayesha', 'member'], ['rehan', 'viewer']], platTasks);
  await project('OPS', 'Operations', 'Keeping the lights on.', [['omar', 'owner'], ['sana', 'maintainer']], opsTasks);

  // Metrics depend on PLAT-9 (cycle detection); the digest is blocked on the metrics.
  const dep = (a, b) => db.query('INSERT INTO task_dependencies VALUES ($1, $2)', [plat.taskIds[a - 1], plat.taskIds[b - 1]]);
  await dep(11, 9);
  await dep(12, 11);
  await dep(13, 9);

  const comment = (n, who, body, hoursAgo) => db.query(
    `INSERT INTO comments (task_id, author_id, body, created_at) VALUES ($1, $2, $3, now() - make_interval(hours => $4))`,
    [plat.taskIds[n - 1], id[who], body, hoursAgo]);
  await comment(8, 'ayesha', 'Ready for a look. Edits now send the version they saw; a stale one gets a 409 with the current task.', 20);
  await comment(8, 'omar', '@ayesha nice. Can the 409 include who made the newer change?', 6);
  await comment(9, 'hamza', 'Using a recursive CTE to walk the chain. Locking the project row so two people cannot add A->B and B->A together.', 30);
  await comment(12, 'hamza', 'Parked until the metrics land, the digest needs them. @omar ok to leave this blocked?', 50);

  await db.query(`INSERT INTO notifications (user_id, task_id, kind, message) VALUES
    ($1, $3, 'mention', 'omar mentioned you on PLAT-8'),
    ($2, $4, 'review', 'PLAT-8 is ready for review: Optimistic locking on task edits')`,
    [id.ayesha, id.omar, plat.taskIds[7], plat.taskIds[7]]);

  await db.query('COMMIT');
  await db.end();
  console.log('Seeded. Sign in with any of these (password: password123):');
  for (const [name, handle] of people) console.log(`  ${handle}@platform.test  (${name})`);
  console.log('  sana = owner, omar = maintainer, hamza & ayesha = members, rehan = viewer');
})().catch((err) => { console.error(err); process.exit(1); });
