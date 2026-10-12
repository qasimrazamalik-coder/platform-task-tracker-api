const express = require('express');
const { z } = require('zod');
const { query, transaction } = require('../../db');
const { validate } = require('../../middleware/validate');
const { loadProject } = require('../projects/access');
const { STATUSES } = require('./workflow');
const svc = require('./service');

// Mounted at /api/projects/:key/tasks
const router = express.Router({ mergeParams: true });

const num = z.coerce.number().int().positive();
const params = z.object({ key: z.string(), number: num });
const handle = z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,24}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10000).optional(),
  status: z.enum(['backlog', 'todo']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  assignee: handle.optional(),
  dueDate: date.optional(),
});

const updateSchema = z.object({
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10000).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  assignee: handle.nullable().optional(),
  dueDate: date.nullable().optional(),
});

const listSchema = z.object({
  status: z.enum(STATUSES).optional(),
  assignee: z.string().trim().toLowerCase().optional(),
  q: z.string().trim().max(100).optional(),
  overdue: z.enum(['true', 'false']).optional(),
});

router.get('/', validate({ query: listSchema }), async (req, res) => {
  const project = await loadProject({ query }, req.params.key, req.user.id);
  res.json(await svc.list({ query }, project, req.user, req.valid.query));
});

router.post('/', validate({ body: createSchema }), async (req, res) => {
  const task = await transaction(async (c) => svc.create(c, await loadProject(c, req.params.key, req.user.id), req.user, req.valid.body));
  res.status(201).json(task);
});

router.get('/:number', validate({ params }), async (req, res) => {
  const project = await loadProject({ query }, req.params.key, req.user.id);
  res.json(await svc.detail({ query }, project, req.user, req.valid.params.number));
});

router.patch('/:number', validate({ params, body: updateSchema }), async (req, res) => {
  res.json(await transaction(async (c) =>
    svc.update(c, await loadProject(c, req.params.key, req.user.id), req.user, req.valid.params.number, req.valid.body)));
});

router.post('/:number/transition',
  validate({ params, body: z.object({ to: z.enum(STATUSES), version: z.number().int().positive() }) }),
  async (req, res) => {
    res.json(await transaction(async (c) =>
      svc.transition(c, await loadProject(c, req.params.key, req.user.id), req.user, req.valid.params.number, req.valid.body)));
  });

router.post('/:number/dependencies', validate({ params, body: z.object({ dependsOn: num }) }), async (req, res) => {
  res.status(201).json(await transaction(async (c) =>
    svc.addDependency(c, await loadProject(c, req.params.key, req.user.id), req.user, req.valid.params.number, req.valid.body.dependsOn)));
});

router.delete('/:number/dependencies/:dependsOn', validate({ params: params.extend({ dependsOn: num }) }), async (req, res) => {
  await transaction(async (c) =>
    svc.removeDependency(c, await loadProject(c, req.params.key, req.user.id), req.user, req.valid.params.number, req.valid.params.dependsOn));
  res.status(204).end();
});

router.put('/:number/position', validate({ params, body: z.object({ before: num.nullable() }) }), async (req, res) => {
  res.json(await transaction(async (c) =>
    svc.move(c, await loadProject(c, req.params.key, req.user.id), req.user, req.valid.params.number, req.valid.body.before)));
});

module.exports = { router };
