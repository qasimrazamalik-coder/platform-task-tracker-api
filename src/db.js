const { Pool, types } = require('pg');
const config = require('./config');

types.setTypeParser(20, (v) => Number(v));   // BIGINT -> number
types.setTypeParser(1700, (v) => Number(v)); // NUMERIC (task position) -> number
types.setTypeParser(1082, (v) => v);         // DATE stays 'YYYY-MM-DD', no timezone shifting

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on('error', (err) => console.error('Unexpected idle client error', err));

const query = (text, params) => pool.query(text, params);

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Appends to the activity log, inside the caller's transaction. */
function logActivity(client, { projectId, taskId = null, actorId, kind, from = null, to = null }) {
  return client.query(
    `INSERT INTO activity (project_id, task_id, actor_id, kind, from_value, to_value)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [projectId, taskId, actorId, kind, from, to]
  );
}

/** Queues a notification, skipping the person who caused it. */
async function notify(client, { userIds, actorId, taskId, kind, message }) {
  const targets = [...new Set(userIds.filter((id) => id && id !== actorId))];
  if (!targets.length) return;
  await client.query(
    `INSERT INTO notifications (user_id, task_id, kind, message)
     SELECT u, $2, $3, $4 FROM unnest($1::bigint[]) u`,
    [targets, taskId, kind, message]
  );
}

module.exports = { pool, query, transaction, logActivity, notify };
