const { logActivity, notify } = require('../../db');
const { atLeast, requireRole } = require('../projects/access');
const { checkTransition, allowedTransitions } = require('./workflow');
const { AppError, notFound, conflict, forbidden, badRequest } = require('../../errors');

// One SQL shape for every task the API returns.
const TASK_SELECT = `
  SELECT t.*, p.key,
         a.handle AS assignee_handle, a.name AS assignee_name,
         r.handle AS reporter_handle, r.name AS reporter_name,
         (SELECT count(*) FROM task_dependencies d JOIN tasks dt ON dt.id = d.depends_on_id
           WHERE d.task_id = t.id AND dt.status <> 'done') AS open_deps,
         (SELECT count(*) FROM comments c WHERE c.task_id = t.id) AS comment_count,
         (t.due_date < current_date AND t.status <> 'done') AS overdue
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN users a ON a.id = t.assignee_id
    JOIN users r ON r.id = t.reporter_id`;

const toTask = (r) => ({
  ref: `${r.key}-${r.number}`,
  number: r.number,
  title: r.title,
  description: r.description,
  status: r.status,
  priority: r.priority,
  assignee: r.assignee_handle ? { handle: r.assignee_handle, name: r.assignee_name } : null,
  reporter: { handle: r.reporter_handle, name: r.reporter_name },
  dueDate: r.due_date,
  overdue: r.overdue,
  position: r.position,
  version: r.version,
  openDependencies: r.open_deps,
  commentCount: r.comment_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
});

async function fetchTask(db, projectId, number) {
  const { rows: [row] } = await db.query(`${TASK_SELECT} WHERE t.project_id = $1 AND t.number = $2`, [projectId, number]);
  if (!row) throw notFound(`Task ${number}`);
  return row;
}

async function lockTask(client, projectId, number) {
  const { rows: [t] } = await client.query(
    'SELECT * FROM tasks WHERE project_id = $1 AND number = $2 FOR UPDATE', [projectId, number]);
  if (!t) throw notFound(`Task ${number}`);
  return t;
}

/** Optimistic locking: the client must prove it saw the latest version. */
async function assertVersion(client, task, version) {
  if (task.version === version) return;
  const current = toTask(await fetchTask(client, task.project_id, task.number));
  throw new AppError(409, 'VERSION_CONFLICT',
    'Someone changed this task after you opened it. Review their changes and try again.', { current });
}

async function memberByHandle(db, projectId, handle) {
  const { rows: [m] } = await db.query(
    `SELECT u.id, u.handle, m.role FROM users u JOIN project_members m ON m.user_id = u.id
      WHERE m.project_id = $1 AND u.handle = $2`, [projectId, handle]);
  if (!m || !atLeast(m.role, 'member')) {
    throw badRequest('ASSIGNEE_NOT_MEMBER', `@${handle} is not a member of this project who can take tasks.`);
  }
  return m;
}

async function openDependencyCount(db, taskId) {
  const { rows: [r] } = await db.query(
    `SELECT count(*) AS n FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id
      WHERE d.task_id = $1 AND t.status <> 'done'`, [taskId]);
  return r.n;
}

/**
 * Tasks the user has in progress in this project, excluding one task.
 * Locking their membership row first serialises every "start work" for that
 * person, so parallel requests cannot all squeeze under the WIP limit.
 */
async function lockedWip(client, projectId, userId, excludeTaskId) {
  await client.query('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE', [projectId, userId]);
  const { rows: [r] } = await client.query(
    `SELECT count(*) AS n FROM tasks
      WHERE project_id = $1 AND assignee_id = $2 AND status = 'in_progress' AND id <> $3`,
    [projectId, userId, excludeTaskId]);
  return r.n;
}

async function create(client, project, actor, input) {
  requireRole(project, 'member', 'Viewers cannot create tasks.');
  // The counter row is locked by this UPDATE, so concurrent creates get
  // consecutive numbers with no gaps and no duplicates.
  const { rows: [{ number }] } = await client.query(
    'UPDATE projects SET next_number = next_number + 1 WHERE id = $1 RETURNING next_number - 1 AS number', [project.id]);
  const assignee = input.assignee ? await memberByHandle(client, project.id, input.assignee) : null;
  const { rows: [{ pos }] } = await client.query(
    'SELECT coalesce(max(position), 0) + 1024 AS pos FROM tasks WHERE project_id = $1', [project.id]);

  const { rows: [t] } = await client.query(
    `INSERT INTO tasks (project_id, number, title, description, status, priority, assignee_id, reporter_id, due_date, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [project.id, number, input.title, input.description ?? '', input.status ?? 'backlog', input.priority ?? 'normal',
      assignee?.id ?? null, actor.id, input.dueDate ?? null, pos]);
  await logActivity(client, { projectId: project.id, taskId: t.id, actorId: actor.id, kind: 'created', to: t.status });
  if (assignee) {
    await notify(client, { userIds: [assignee.id], actorId: actor.id, taskId: t.id, kind: 'assigned',
      message: `${actor.handle} assigned you ${project.key}-${number}: ${t.title}` });
  }
  return toTask(await fetchTask(client, project.id, number));
}

async function update(client, project, actor, number, input) {
  const task = await lockTask(client, project.id, number);
  const canEdit = atLeast(project.role, 'maintainer')
    || (atLeast(project.role, 'member') && [task.reporter_id, task.assignee_id].includes(actor.id));
  if (!canEdit) throw forbidden('You can edit tasks you reported or are assigned to.');
  await assertVersion(client, task, input.version);

  let assigneeId = task.assignee_id;
  if (input.assignee !== undefined) {
    assigneeId = input.assignee === null ? null : (await memberByHandle(client, project.id, input.assignee)).id;
    // Handing over work that is in progress must respect the new person's WIP limit.
    if (assigneeId && assigneeId !== task.assignee_id && task.status === 'in_progress') {
      const wip = await lockedWip(client, project.id, assigneeId, task.id);
      if (wip >= project.wip_limit) throw conflict('WIP_LIMIT', `That person already has ${wip} tasks in progress, the project limit.`);
    }
  }

  await client.query(
    `UPDATE tasks SET title = $2, description = $3, priority = $4, due_date = $5, assignee_id = $6, version = version + 1
      WHERE id = $1`,
    [task.id, input.title ?? task.title, input.description ?? task.description, input.priority ?? task.priority,
      input.dueDate === undefined ? task.due_date : input.dueDate, assigneeId]);

  if (assigneeId !== task.assignee_id) {
    await logActivity(client, { projectId: project.id, taskId: task.id, actorId: actor.id, kind: 'assigned',
      from: String(task.assignee_id ?? ''), to: String(assigneeId ?? '') });
    if (assigneeId) {
      await notify(client, { userIds: [assigneeId], actorId: actor.id, taskId: task.id, kind: 'assigned',
        message: `${actor.handle} assigned you ${project.key}-${number}: ${input.title ?? task.title}` });
    }
  }
  const edited = ['title', 'description', 'priority', 'dueDate'].filter((k) => input[k] !== undefined);
  if (edited.length) {
    await logActivity(client, { projectId: project.id, taskId: task.id, actorId: actor.id, kind: 'edited', to: edited.join(', ') });
  }
  return toTask(await fetchTask(client, project.id, number));
}

async function transition(client, project, actor, number, { to, version }) {
  const task = await lockTask(client, project.id, number);
  await assertVersion(client, task, version);

  // Starting unassigned work assigns it to whoever starts it.
  const assigneeId = to === 'in_progress' && !task.assignee_id ? actor.id : task.assignee_id;
  const facts = {};
  if (to === 'in_progress') {
    facts.openDependencies = await openDependencyCount(client, task.id);
    facts.assigneeWip = await lockedWip(client, project.id, assigneeId, task.id);
    facts.wipLimit = project.wip_limit;
  }
  const denied = checkTransition({ status: task.status, assigneeId: task.assignee_id }, to, { id: actor.id, role: project.role }, facts);
  if (denied) throw new AppError(denied.status, denied.code, denied.message);

  await client.query(
    `UPDATE tasks SET status = $2::task_status, assignee_id = $3, version = version + 1,
            completed_at = CASE WHEN $2::task_status = 'done' THEN now() ELSE NULL END
      WHERE id = $1`,
    [task.id, to, assigneeId]);
  await logActivity(client, { projectId: project.id, taskId: task.id, actorId: actor.id, kind: 'status', from: task.status, to });

  const ref = `${project.key}-${number}`;
  if (to === 'in_review') {
    const { rows } = await client.query(
      `SELECT user_id FROM project_members WHERE project_id = $1 AND role IN ('maintainer', 'owner')`, [project.id]);
    await notify(client, { userIds: rows.map((r) => r.user_id), actorId: actor.id, taskId: task.id, kind: 'review',
      message: `${ref} is ready for review: ${task.title}` });
  } else if (task.status === 'in_review') {
    await notify(client, { userIds: [assigneeId], actorId: actor.id, taskId: task.id, kind: to === 'done' ? 'approved' : 'changes',
      message: to === 'done' ? `${actor.handle} approved ${ref}` : `${actor.handle} sent ${ref} back for changes` });
  }
  return toTask(await fetchTask(client, project.id, number));
}

/**
 * Records "task depends on other". The project row is locked so two people
 * cannot add A->B and B->A at the same moment and slip a cycle past the check.
 */
async function addDependency(client, project, actor, number, dependsOnNumber) {
  requireRole(project, 'member', 'Viewers cannot change dependencies.');
  await client.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [project.id]);
  if (number === dependsOnNumber) throw badRequest('SELF_DEPENDENCY', 'A task cannot depend on itself.');
  const task = await fetchTask(client, project.id, number);
  const other = await fetchTask(client, project.id, dependsOnNumber);

  // Would the new edge close a loop? Walk everything `other` already depends on.
  const { rows: [cycle] } = await client.query(
    `WITH RECURSIVE chain(id) AS (
        SELECT depends_on_id FROM task_dependencies WHERE task_id = $1
        UNION
        SELECT d.depends_on_id FROM task_dependencies d JOIN chain c ON d.task_id = c.id)
     SELECT 1 FROM chain WHERE id = $2`,
    [other.id, task.id]);
  if (cycle) {
    throw conflict('DEPENDENCY_CYCLE',
      `${project.key}-${dependsOnNumber} already depends on ${project.key}-${number}, directly or through other tasks.`);
  }
  await client.query('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES ($1, $2)', [task.id, other.id]);
  await logActivity(client, { projectId: project.id, taskId: task.id, actorId: actor.id, kind: 'dependency_added',
    to: `${project.key}-${dependsOnNumber}` });
  return dependencies(client, task.id);
}

async function removeDependency(client, project, actor, number, dependsOnNumber) {
  requireRole(project, 'member', 'Viewers cannot change dependencies.');
  const task = await fetchTask(client, project.id, number);
  const other = await fetchTask(client, project.id, dependsOnNumber);
  const { rowCount } = await client.query(
    'DELETE FROM task_dependencies WHERE task_id = $1 AND depends_on_id = $2', [task.id, other.id]);
  if (!rowCount) throw notFound('Dependency');
  await logActivity(client, { projectId: project.id, taskId: task.id, actorId: actor.id, kind: 'dependency_removed',
    from: `${project.key}-${dependsOnNumber}` });
}

async function dependencies(db, taskId) {
  const q = (col, other) => db.query(
    `SELECT p.key || '-' || t.number AS ref, t.number, t.title, t.status
       FROM task_dependencies d JOIN tasks t ON t.id = d.${other} JOIN projects p ON p.id = t.project_id
      WHERE d.${col} = $1 ORDER BY t.number`, [taskId]);
  const [{ rows: dependsOn }, { rows: blocks }] = await Promise.all([q('task_id', 'depends_on_id'), q('depends_on_id', 'task_id')]);
  return { dependsOn, blocks };
}

/** Drag to reorder: the new position is the midpoint between neighbours. NUMERIC never runs out of room. */
async function move(client, project, actor, number, beforeNumber) {
  requireRole(project, 'member', 'Viewers cannot reorder tasks.');
  const task = await lockTask(client, project.id, number);
  let position;
  if (beforeNumber == null) {
    const { rows: [r] } = await client.query('SELECT coalesce(max(position), 0) + 1024 AS p FROM tasks WHERE project_id = $1 AND id <> $2', [project.id, task.id]);
    position = r.p;
  } else {
    const anchor = await fetchTask(client, project.id, beforeNumber);
    const { rows: [r] } = await client.query(
      `SELECT coalesce(max(position), $2::numeric - 2048) AS prev FROM tasks WHERE project_id = $1 AND position < $2::numeric AND id <> $3`,
      [project.id, anchor.position, task.id]);
    position = (Number(r.prev) + Number(anchor.position)) / 2;
  }
  await client.query('UPDATE tasks SET position = $2 WHERE id = $1', [task.id, position]);
  return toTask(await fetchTask(client, project.id, number));
}

async function detail(db, project, actor, number) {
  const row = await fetchTask(db, project.id, number);
  const task = toTask(row);
  const [deps, comments, activity, wips] = await Promise.all([
    dependencies(db, row.id),
    db.query(`SELECT c.id, c.body, c.created_at AS "createdAt", u.handle, u.name
                FROM comments c JOIN users u ON u.id = c.author_id WHERE c.task_id = $1 ORDER BY c.created_at`, [row.id]),
    db.query(`SELECT a.kind, a.from_value AS "from", a.to_value AS "to", a.at, u.handle
                FROM activity a LEFT JOIN users u ON u.id = a.actor_id WHERE a.task_id = $1 ORDER BY a.id DESC LIMIT 30`, [row.id]),
    db.query(`SELECT assignee_id, count(*) AS n FROM tasks
               WHERE project_id = $1 AND status = 'in_progress' AND id <> $2 AND assignee_id = ANY($3::bigint[])
               GROUP BY assignee_id`, [project.id, row.id, [actor.id, row.assignee_id].filter(Boolean)]),
  ]);
  const wipOf = (id) => Number(wips.rows.find((w) => w.assignee_id === id)?.n || 0);
  const facts = { openDependencies: row.open_deps, wipLimit: project.wip_limit, assigneeWip: wipOf(row.assignee_id), actorWip: wipOf(actor.id) };
  return {
    ...task,
    dependsOn: deps.dependsOn,
    blocks: deps.blocks,
    comments: comments.rows,
    activity: activity.rows,
    allowedTransitions: allowedTransitions({ status: row.status, assigneeId: row.assignee_id }, { id: actor.id, role: project.role }, facts),
  };
}

async function list(db, project, actor, f) {
  const { rows } = await db.query(
    `${TASK_SELECT}
      WHERE t.project_id = $1
        AND ($2::task_status IS NULL OR t.status = $2)
        AND ($3::text IS NULL OR a.handle = $3)
        AND ($4::text IS NULL OR t.title ILIKE '%' || $4 || '%' OR p.key || '-' || t.number = upper($4))
        AND ($5::boolean IS NOT TRUE OR (t.due_date < current_date AND t.status <> 'done'))
      ORDER BY array_position(ARRAY['in_progress','in_review','blocked','todo','backlog','done']::task_status[], t.status), t.position`,
    [project.id, f.status ?? null, f.assignee === 'me' ? actor.handle : f.assignee ?? null, f.q ?? null, f.overdue === 'true']);
  return rows.map(toTask);
}

module.exports = { create, update, transition, addDependency, removeDependency, move, detail, list, toTask };
