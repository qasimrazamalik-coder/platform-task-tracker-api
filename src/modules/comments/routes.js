const express = require('express');
const { z } = require('zod');
const { transaction, logActivity, notify } = require('../../db');
const { validate } = require('../../middleware/validate');
const { loadProject, requireRole } = require('../projects/access');
const { notFound } = require('../../errors');

// Mounted at /api/projects/:key/tasks/:number/comments
const router = express.Router({ mergeParams: true });

const MENTION = /(^|[^a-z0-9_])@([a-z0-9_]{2,24})/gi;

/** Handles mentioned in a comment, lowercased and deduplicated. */
function mentionedHandles(body) {
  return [...new Set([...body.matchAll(MENTION)].map((m) => m[2].toLowerCase()))];
}

router.post('/', validate({
  params: z.object({ key: z.string(), number: z.coerce.number().int().positive() }),
  body: z.object({ body: z.string().trim().min(1).max(4000) }),
}), async (req, res) => {
  const comment = await transaction(async (c) => {
    const p = await loadProject(c, req.params.key, req.user.id);
    requireRole(p, 'member', 'Viewers can read but not comment.');
    const { rows: [t] } = await c.query('SELECT id, title, assignee_id, reporter_id FROM tasks WHERE project_id = $1 AND number = $2',
      [p.id, req.valid.params.number]);
    if (!t) throw notFound('Task');

    const { rows: [row] } = await c.query(
      'INSERT INTO comments (task_id, author_id, body) VALUES ($1, $2, $3) RETURNING id, body, created_at AS "createdAt"',
      [t.id, req.user.id, req.valid.body.body]);
    await logActivity(c, { projectId: p.id, taskId: t.id, actorId: req.user.id, kind: 'commented' });

    // Only people on this project can be mentioned, so @handles never leak to outsiders.
    const handles = mentionedHandles(row.body);
    const { rows: mentioned } = handles.length ? await c.query(
      `SELECT u.id FROM users u JOIN project_members m ON m.user_id = u.id AND m.project_id = $1 WHERE u.handle = ANY($2)`,
      [p.id, handles]) : { rows: [] };
    const ref = `${p.key}-${req.valid.params.number}`;
    await notify(c, { userIds: mentioned.map((m) => m.id), actorId: req.user.id, taskId: t.id, kind: 'mention',
      message: `${req.user.handle} mentioned you on ${ref}` });
    const mentionedIds = new Set(mentioned.map((m) => m.id));
    await notify(c, { userIds: [t.assignee_id, t.reporter_id].filter((id) => !mentionedIds.has(id)), actorId: req.user.id,
      taskId: t.id, kind: 'comment', message: `${req.user.handle} commented on ${ref}: ${t.title}` });

    return { ...row, handle: req.user.handle, mentioned: mentioned.length };
  });
  res.status(201).json(comment);
});

module.exports = { router, mentionedHandles };
