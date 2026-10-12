const request = require('supertest');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const { pool, query } = require('../src/db');
const { signToken } = require('../src/middleware/auth');

const app = createApp();
const api = () => request(app);

let seq = 0;
const HASH = bcrypt.hashSync('password123', 4);

async function reset() {
  await query('TRUNCATE activity, notifications, comments, task_dependencies, tasks, project_members, projects, users RESTART IDENTITY CASCADE');
}

async function makeUser(handle) {
  seq += 1;
  const h = handle || `user${seq}`;
  const { rows: [u] } = await query(
    'INSERT INTO users (name, handle, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING *',
    [`User ${h}`, h, `${h}@test.local`, HASH]);
  return { ...u, auth: { Authorization: `Bearer ${signToken(u)}` } };
}

let keySeq = 0;
/** Creates a project owned by `owner` and adds the others with their roles: [[user, 'member'], ...] */
async function makeProject(owner, members = [], { wipLimit = 3 } = {}) {
  keySeq += 1;
  const key = `P${String.fromCharCode(64 + ((keySeq - 1) % 26) + 1)}${String.fromCharCode(64 + Math.floor((keySeq - 1) / 26) + 1)}`;
  const res = await api().post('/api/projects').set(owner.auth).send({ key, name: `Project ${key}`, wipLimit });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  for (const [user, role] of members) {
    await api().post(`/api/projects/${key}/members`).set(owner.auth).send({ handle: user.handle, role });
  }
  return key;
}

async function makeTask(user, key, body = {}) {
  const res = await api().post(`/api/projects/${key}/tasks`).set(user.auth).send({ title: 'A task', ...body });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body;
}

/** Moves a task, fetching the current version first like a real client would. */
async function move(user, key, number, to) {
  const t = await api().get(`/api/projects/${key}/tasks/${number}`).set(user.auth);
  return api().post(`/api/projects/${key}/tasks/${number}/transition`).set(user.auth).send({ to, version: t.body.version });
}

const close = () => pool.end();

module.exports = { api, reset, makeUser, makeProject, makeTask, move, query, close };
