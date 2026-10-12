const express = require('express');
const { z } = require('zod');
const { query } = require('../../db');
const { validate } = require('../../middleware/validate');

const router = express.Router();

router.get('/', validate({ query: z.object({ unread: z.enum(['true', 'false']).optional() }) }), async (req, res) => {
  const { rows } = await query(
    `SELECT n.id, n.kind, n.message, n.created_at AS "createdAt", n.read_at AS "readAt",
            p.key || '-' || t.number AS task
       FROM notifications n
       LEFT JOIN tasks t ON t.id = n.task_id
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE n.user_id = $1 AND ($2::boolean IS NOT TRUE OR n.read_at IS NULL)
      ORDER BY n.id DESC LIMIT 50`,
    [req.user.id, req.valid.query.unread === 'true']);
  res.json(rows);
});

// Mark some or all as read. Scoped to the caller, so ids belonging to others are silently ignored.
router.post('/read', validate({ body: z.object({ ids: z.array(z.number().int().positive()).max(200).optional() }) }), async (req, res) => {
  const { rowCount } = await query(
    `UPDATE notifications SET read_at = now()
      WHERE user_id = $1 AND read_at IS NULL AND ($2::bigint[] IS NULL OR id = ANY($2))`,
    [req.user.id, req.valid.body.ids ?? null]);
  res.json({ marked: rowCount });
});

module.exports = { router };
