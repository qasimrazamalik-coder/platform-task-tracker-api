const { notFound, forbidden } = require('../../errors');

// Roles are ordered: each one can do everything the one below can.
const RANK = { viewer: 0, member: 1, maintainer: 2, owner: 3 };
const atLeast = (role, min) => RANK[role] >= RANK[min];

/**
 * Loads a project by its key together with the caller's role in it.
 * Non-members get a 404, not a 403: they should not learn the project exists.
 */
async function loadProject(db, key, userId, { lock = false } = {}) {
  const { rows: [p] } = await db.query(
    `SELECT p.*, m.role
       FROM projects p
       JOIN project_members m ON m.project_id = p.id AND m.user_id = $2
      WHERE p.key = $1
      ${lock ? 'FOR UPDATE OF p' : ''}`,
    [String(key).toUpperCase(), userId]
  );
  if (!p) throw notFound('Project');
  return p;
}

function requireRole(project, min, message) {
  if (!atLeast(project.role, min)) {
    throw forbidden(message || `This needs the ${min} role on ${project.key}. Yours is ${project.role}.`);
  }
}

module.exports = { RANK, atLeast, loadProject, requireRole };
