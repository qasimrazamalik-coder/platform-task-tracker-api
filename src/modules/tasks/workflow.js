/**
 * The task workflow as a pure function: no database, no Express.
 * Given a task, a target status, who is asking and some facts the service
 * looked up, it returns null (allowed) or { status, code, message }.
 * Keeping it pure means every rule is unit-tested in isolation
 * (tests/workflow.test.js) and the same function decides which buttons the UI shows.
 */
const { atLeast } = require('../projects/access');

const STATUSES = ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done'];

const TRANSITIONS = {
  backlog: ['todo'],
  todo: ['in_progress', 'backlog'],
  in_progress: ['in_review', 'blocked', 'todo'],
  blocked: ['in_progress'],
  in_review: ['done', 'in_progress'],
  done: ['todo'],
};

const deny = (status, code, message) => ({ status, code, message });

/**
 * @param task   { status, assigneeId }
 * @param to     target status
 * @param actor  { id, role }               role in this project
 * @param facts  { openDependencies, assigneeWip, wipLimit }
 *               assigneeWip = tasks the (future) assignee already has in progress, excluding this one
 */
function checkTransition(task, to, actor, facts = {}) {
  if (!STATUSES.includes(to)) return deny(400, 'UNKNOWN_STATUS', `"${to}" is not a status.`);
  if (task.status === to) return deny(409, 'NO_CHANGE', `The task is already ${to}.`);
  if (!TRANSITIONS[task.status].includes(to)) {
    return deny(409, 'INVALID_TRANSITION', `A task cannot go from ${task.status} to ${to}.`);
  }
  if (!atLeast(actor.role, 'member')) return deny(403, 'READ_ONLY', 'Viewers cannot change tasks.');

  const isMaintainer = atLeast(actor.role, 'maintainer');
  const isAssignee = task.assigneeId === actor.id;

  // Members work on their own tasks (or pick up unassigned ones).
  if (!isMaintainer && task.assigneeId && !isAssignee) {
    return deny(403, 'NOT_YOUR_TASK', 'This task is assigned to someone else.');
  }

  if (to === 'done') {
    if (!isMaintainer) return deny(403, 'NEEDS_MAINTAINER', 'Only a maintainer can approve a review.');
    if (isAssignee) return deny(403, 'FOUR_EYES', 'Someone other than the assignee has to approve the work.');
  }
  if (task.status === 'done' && !isMaintainer) {
    return deny(403, 'NEEDS_MAINTAINER', 'Only a maintainer can reopen a finished task.');
  }

  if (to === 'in_progress') {
    if (facts.openDependencies > 0) {
      return deny(409, 'BLOCKED_BY_DEPENDENCIES',
        `${facts.openDependencies} task${facts.openDependencies === 1 ? '' : 's'} this depends on ${facts.openDependencies === 1 ? 'is' : 'are'} not done yet.`);
    }
    if (facts.wipLimit !== undefined && facts.assigneeWip >= facts.wipLimit) {
      return deny(409, 'WIP_LIMIT', `That person already has ${facts.assigneeWip} tasks in progress, the project limit.`);
    }
  }
  return null;
}

/** Which targets the actor could move this task to right now (drives the UI buttons). */
function allowedTransitions(task, actor, facts) {
  return TRANSITIONS[task.status].filter((to) => {
    const assigneeWip = to === 'in_progress' && !task.assigneeId ? facts.actorWip : facts.assigneeWip;
    return checkTransition(task, to, actor, { ...facts, assigneeWip }) === null;
  });
}

module.exports = { STATUSES, TRANSITIONS, checkTransition, allowedTransitions };
