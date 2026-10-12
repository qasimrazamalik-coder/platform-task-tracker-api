const express = require('express');
const { z } = require('zod');
const { query, transaction, logActivity, notify } = require('../../db');
const { validate } = require('../../middleware/validate');
const { loadProject, requireRole, RANK } = require('./access');
const { notFound, conflict, forbidden, badRequest } = require('../../errors');

const router = express.Router();

const keyParam = z.object({ key: z.string().trim().toUpperCase() });
const role = z.enum(['owner', 'maintainer', 'member', 'viewer']);

const toProject = (p) => ({
  key: p.key, name: p.name, description: p.description, wipLimit: p.wip_limit,
  myRole: p.role, createdAt: p.created_at,
});

// Projects I belong to, with live counts for the sidebar.
router.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, m.role,
            count(t.id) FILTER (WHERE t.status <> 'done') AS open_tasks,
            count(t.id) FILTER (WHERE t.assignee_id = $1 AND t.status <> 'done') AS mine
       FROM projects p
       JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
       LEFT JOIN tasks t ON t.project_id = p.id
      WHERE p.archived_at IS NULL
      GROUP BY p.id, m.role ORDER BY p.name`,
    [req.user.id]);
  res.json(rows.map((p) => ({ ...toProject(p), openTasks: p.open_tasks, assignedToMe: p.mine })));
});

router.post('/', validate({ body: z.object({
  key: z.string().trim().toUpperCase().regex(/^[A-Z]{2,6}$/, 'Use 2 to 6 capital letters, like PLAT.'),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).default(''),
  wipLimit: z.number().int().min(1).max(20).default(3),
}) }), async (req, res) => {
  const b = req.valid.body;
  const project = await transaction(async (c) => {
    const { rows: [p] } = await c.query(
      'INSERT INTO projects (key, name, description, wip_limit) VALUES ($1, $2, $3, $4) RETURNING *',
      [b.key, b.name, b.description, b.wipLimit]);
    await c.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`, [p.id, req.user.id]);
    await logActivity(c, { projectId: p.id, actorId: req.user.id, kind: 'project_created', to: p.key });
    return { ...p, role: 'owner' };
  });
  res.status(201).json(toProject(project));
});

router.get('/:key', validate({ params: keyParam }), async (req, res) => {
  const p = await loadProject({ query }, req.valid.params.key, req.user.id);
  const { rows: members } = await query(
    `SELECT u.handle, u.name, m.role,
            (SELECT count(*) FROM tasks t WHERE t.project_id = $1 AND t.assignee_id = u.id AND t.status = 'in_progress') AS wip
       FROM project_members m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = $1
      ORDER BY array_position(ARRAY['owner','maintainer','member','viewer']::member_role[], m.role), u.name`, [p.id]);
  res.json({ ...toProject(p), members });
});

router.patch('/:key', validate({ params: keyParam, body: z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  wipLimit: z.number().int().min(1).max(20).optional(),
}) }), async (req, res) => {
  const updated = await transaction(async (c) => {
    const p = await loadProject(c, req.valid.params.key, req.user.id, { lock: true });
    requireRole(p, 'maintainer');
    const b = req.valid.body;
    const { rows: [row] } = await c.query(
      `UPDATE projects SET name = coalesce($2, name), description = coalesce($3, description), wip_limit = coalesce($4, wip_limit)
        WHERE id = $1 RETURNING *`, [p.id, b.name ?? null, b.description ?? null, b.wipLimit ?? null]);
    return { ...row, role: p.role };
  });
  res.json(toProject(updated));
});

// Adding people. Maintainers may add members and viewers; only owners hand out maintainer or owner.
router.post('/:key/members', validate({ params: keyParam, body: z.object({ handle: z.string().trim().toLowerCase(), role }) }),
  async (req, res) => {
    const member = await transaction(async (c) => {
      const p = await loadProject(c, req.valid.params.key, req.user.id);
      requireRole(p, 'maintainer');
      const { handle, role: newRole } = req.valid.body;
      if (RANK[newRole] >= RANK.maintainer && p.role !== 'owner') throw forbidden('Only an owner can add maintainers or owners.');
      const { rows: [u] } = await c.query('SELECT id, handle, name FROM users WHERE handle = $1', [handle]);
      if (!u) throw notFound(`User @${handle}`);
      await c.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [p.id, u.id, newRole]);
      await logActivity(c, { projectId: p.id, actorId: req.user.id, kind: 'member_added', to: `${handle}:${newRole}` });
      await notify(c, { userIds: [u.id], actorId: req.user.id, taskId: null, kind: 'invited',
        message: `${req.user.handle} added you to ${p.key} as ${newRole}` });
      return { handle: u.handle, name: u.name, role: newRole };
    });
    res.status(201).json(member);
  });

/**
 * Changing or removing members, with one invariant: a project always keeps at
 * least one owner. The owner rows are locked while counting so two owners
 * cannot demote each other at the same moment.
 */
async function guardLastOwner(c, projectId, userId) {
  const { rows } = await c.query(
    `SELECT user_id FROM project_members WHERE project_id = $1 AND role = 'owner' FOR UPDATE`, [projectId]);
  if (rows.length === 1 && rows[0].user_id === userId) {
    throw conflict('LAST_OWNER', 'A project needs at least one owner. Make someone else owner first.');
  }
}

router.patch('/:key/members/:handle', validate({ params: keyParam.extend({ handle: z.string().toLowerCase() }), body: z.object({ role }) }),
  async (req, res) => {
    const result = await transaction(async (c) => {
      const p = await loadProject(c, req.valid.params.key, req.user.id);
      requireRole(p, 'owner');
      const { rows: [m] } = await c.query(
        `SELECT m.user_id, m.role FROM project_members m JOIN users u ON u.id = m.user_id
          WHERE m.project_id = $1 AND u.handle = $2 FOR UPDATE OF m`, [p.id, req.valid.params.handle]);
      if (!m) throw notFound('Member');
      if (m.role === 'owner' && req.valid.body.role !== 'owner') await guardLastOwner(c, p.id, m.user_id);
      await c.query('UPDATE project_members SET role = $3 WHERE project_id = $1 AND user_id = $2', [p.id, m.user_id, req.valid.body.role]);
      await logActivity(c, { projectId: p.id, actorId: req.user.id, kind: 'role_changed', from: m.role, to: `${req.valid.params.handle}:${req.valid.body.role}` });
      return { handle: req.valid.params.handle, role: req.valid.body.role };
    });
    res.json(result);
  });

router.delete('/:key/members/:handle', validate({ params: keyParam.extend({ handle: z.string().toLowerCase() }) }), async (req, res) => {
  await transaction(async (c) => {
    const p = await loadProject(c, req.valid.params.key, req.user.id);
    const { rows: [m] } = await c.query(
      `SELECT m.user_id, m.role FROM project_members m JOIN users u ON u.id = m.user_id
        WHERE m.project_id = $1 AND u.handle = $2 FOR UPDATE OF m`, [p.id, req.valid.params.handle]);
    if (!m) throw notFound('Member');
    const leavingSelf = m.user_id === req.user.id;
    if (!leavingSelf) requireRole(p, 'owner');
    if (m.role === 'owner') await guardLastOwner(c, p.id, m.user_id);
    // Their open tasks go back to the pool rather than pointing at someone who left.
    await c.query(
      `UPDATE tasks SET assignee_id = NULL, version = version + 1,
              status = CASE WHEN status IN ('in_progress', 'blocked') THEN 'todo'::task_status ELSE status END
        WHERE project_id = $1 AND assignee_id = $2 AND status <> 'done'`, [p.id, m.user_id]);
    await c.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [p.id, m.user_id]);
    await logActivity(c, { projectId: p.id, actorId: req.user.id, kind: 'member_removed', from: req.valid.params.handle });
  });
  res.status(204).end();
});

// Activity feed with keyset pagination: stable even while new events arrive.
router.get('/:key/activity', validate({ params: keyParam, query: z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}) }), async (req, res) => {
  const p = await loadProject({ query }, req.valid.params.key, req.user.id);
  const { before, limit } = req.valid.query;
  const { rows } = await query(
    `SELECT a.id, a.kind, a.from_value AS "from", a.to_value AS "to", a.at, u.handle AS actor,
            CASE WHEN t.id IS NULL THEN NULL ELSE $3 || '-' || t.number END AS task, t.title
       FROM activity a
       LEFT JOIN users u ON u.id = a.actor_id
       LEFT JOIN tasks t ON t.id = a.task_id
      WHERE a.project_id = $1 AND ($2::bigint IS NULL OR a.id < $2)
      ORDER BY a.id DESC LIMIT $4`, [p.id, before ?? null, p.key, limit]);
  res.json({ items: rows, nextBefore: rows.length === limit ? rows[rows.length - 1].id : null });
});

/**
 * Flow metrics computed from the activity log:
 *  - throughput: tasks finished per week, with empty weeks filled in
 *  - cycle time: first move to in_progress until done, median and average
 *  - WIP per person against the limit
 */
router.get('/:key/metrics', validate({ params: keyParam, query: z.object({ weeks: z.coerce.number().int().min(2).max(26).default(8) }) }),
  async (req, res) => {
    const p = await loadProject({ query }, req.valid.params.key, req.user.id);
    const weeks = req.valid.query.weeks;
    const [byStatus, throughput, cycle, wip, overdue] = await Promise.all([
      query(`SELECT s.status, count(t.id)::int AS count
               FROM unnest(enum_range(NULL::task_status)) s(status)
               LEFT JOIN tasks t ON t.status = s.status AND t.project_id = $1
              GROUP BY s.status ORDER BY array_position(enum_range(NULL::task_status), s.status)`, [p.id]),
      query(`SELECT w::date AS week, count(t.id)::int AS done
               FROM generate_series(date_trunc('week', now()) - make_interval(weeks => $2 - 1), date_trunc('week', now()), interval '1 week') w
               LEFT JOIN tasks t ON t.project_id = $1 AND date_trunc('week', t.completed_at) = w
              GROUP BY w ORDER BY w`, [p.id, weeks]),
      query(`SELECT count(*)::int AS tasks,
                    round(avg(hours)::numeric, 1) AS avg_hours,
                    round((percentile_cont(0.5) WITHIN GROUP (ORDER BY hours))::numeric, 1) AS median_hours
               FROM (SELECT extract(epoch FROM t.completed_at - min(a.at)) / 3600 AS hours
                       FROM tasks t JOIN activity a ON a.task_id = t.id AND a.kind = 'status' AND a.to_value = 'in_progress'
                      WHERE t.project_id = $1 AND t.completed_at > now() - make_interval(weeks => $2)
                      GROUP BY t.id) x`, [p.id, weeks]),
      query(`SELECT u.handle, count(t.id)::int AS in_progress
               FROM project_members m JOIN users u ON u.id = m.user_id
               LEFT JOIN tasks t ON t.assignee_id = u.id AND t.project_id = m.project_id AND t.status = 'in_progress'
              WHERE m.project_id = $1 AND m.role <> 'viewer'
              GROUP BY u.handle ORDER BY in_progress DESC, u.handle`, [p.id]),
      query(`SELECT count(*)::int AS n FROM tasks WHERE project_id = $1 AND due_date < current_date AND status <> 'done'`, [p.id]),
    ]);
    res.json({
      byStatus: byStatus.rows,
      throughput: throughput.rows,
      cycleTime: { tasks: cycle.rows[0].tasks, avgHours: cycle.rows[0].avg_hours, medianHours: cycle.rows[0].median_hours },
      wip: { limit: p.wip_limit, people: wip.rows },
      overdue: overdue.rows[0].n,
    });
  });

module.exports = { router };
