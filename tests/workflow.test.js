// Unit tests for the workflow rules. No database, no HTTP: just the pure function.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { checkTransition, allowedTransitions } = require('../src/modules/tasks/workflow');

const ME = 1, OTHER = 2;
const code = (r) => r && r.code;

describe('workflow rules', () => {
  test('follows the transition map', () => {
    assert.equal(checkTransition({ status: 'backlog' }, 'todo', { id: ME, role: 'member' }), null);
    assert.equal(code(checkTransition({ status: 'backlog' }, 'done', { id: ME, role: 'owner' })), 'INVALID_TRANSITION');
    assert.equal(code(checkTransition({ status: 'todo' }, 'todo', { id: ME, role: 'member' })), 'NO_CHANGE');
    assert.equal(code(checkTransition({ status: 'todo' }, 'shipped', { id: ME, role: 'member' })), 'UNKNOWN_STATUS');
  });

  test('viewers are read-only', () => {
    assert.equal(code(checkTransition({ status: 'backlog' }, 'todo', { id: ME, role: 'viewer' })), 'READ_ONLY');
  });

  test("members cannot move someone else's task, maintainers can", () => {
    const task = { status: 'todo', assigneeId: OTHER };
    assert.equal(code(checkTransition(task, 'backlog', { id: ME, role: 'member' })), 'NOT_YOUR_TASK');
    assert.equal(checkTransition(task, 'backlog', { id: ME, role: 'maintainer' }), null);
  });

  test('four eyes: approval needs a maintainer who is not the assignee', () => {
    const mine = { status: 'in_review', assigneeId: ME };
    assert.equal(code(checkTransition(mine, 'done', { id: ME, role: 'member' })), 'NEEDS_MAINTAINER');
    assert.equal(code(checkTransition(mine, 'done', { id: ME, role: 'owner' })), 'FOUR_EYES');
    assert.equal(checkTransition(mine, 'done', { id: OTHER, role: 'maintainer' }), null);
  });

  test('only maintainers reopen finished work', () => {
    const done = { status: 'done', assigneeId: ME };
    assert.equal(code(checkTransition(done, 'todo', { id: ME, role: 'member' })), 'NEEDS_MAINTAINER');
    assert.equal(checkTransition(done, 'todo', { id: OTHER, role: 'maintainer' }), null);
  });

  test('cannot start while dependencies are open or the WIP limit is reached', () => {
    const t = { status: 'todo', assigneeId: ME };
    const actor = { id: ME, role: 'member' };
    assert.equal(code(checkTransition(t, 'in_progress', actor, { openDependencies: 2, assigneeWip: 0, wipLimit: 3 })), 'BLOCKED_BY_DEPENDENCIES');
    assert.equal(code(checkTransition(t, 'in_progress', actor, { openDependencies: 0, assigneeWip: 3, wipLimit: 3 })), 'WIP_LIMIT');
    assert.equal(checkTransition(t, 'in_progress', actor, { openDependencies: 0, assigneeWip: 2, wipLimit: 3 }), null);
  });

  test('allowedTransitions lists only the moves that would succeed', () => {
    const facts = { openDependencies: 0, assigneeWip: 0, actorWip: 0, wipLimit: 3 };
    assert.deepEqual(allowedTransitions({ status: 'in_review', assigneeId: ME }, { id: ME, role: 'owner' }, facts), ['in_progress']);
    assert.deepEqual(allowedTransitions({ status: 'in_review', assigneeId: ME }, { id: OTHER, role: 'maintainer' }, facts), ['done', 'in_progress']);
    assert.deepEqual(allowedTransitions({ status: 'todo', assigneeId: null }, { id: ME, role: 'member' }, { ...facts, actorWip: 3 }), ['backlog']);
  });
});
