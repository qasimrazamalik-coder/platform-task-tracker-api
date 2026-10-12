const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { query } = require('../../db');
const { validate } = require('../../middleware/validate');
const { signToken, authenticate } = require('../../middleware/auth');
const { unauthorized, notFound } = require('../../errors');
const config = require('../../config');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  skip: () => config.env === 'test',
  handler: (_req, res) => res.status(429).json({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again in 15 minutes.' } }),
});

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  handle: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,24}$/, 'Use 2 to 24 lowercase letters, digits or underscores.'),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, 'Use at least 8 characters.').max(72),
});

const publicUser = (u) => ({ id: u.id, name: u.name, handle: u.handle, email: u.email });

router.post('/register', limiter, validate({ body: registerSchema }), async (req, res) => {
  const { name, handle, email, password } = req.valid.body;
  const { rows: [u] } = await query(
    `INSERT INTO users (name, handle, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, handle, email, await bcrypt.hash(password, 10)]
  );
  res.status(201).json({ token: signToken(u), user: publicUser(u) });
});

router.post('/login', limiter, validate({ body: z.object({ email: z.string().trim().toLowerCase(), password: z.string().min(1) }) }),
  async (req, res) => {
    const { rows: [u] } = await query('SELECT * FROM users WHERE lower(email) = $1', [req.valid.body.email]);
    if (!u || !(await bcrypt.compare(req.valid.body.password, u.password_hash))) {
      throw unauthorized('Email or password is incorrect.');
    }
    res.json({ token: signToken(u), user: publicUser(u) });
  });

router.get('/me', authenticate, async (req, res) => {
  const { rows: [u] } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!u) throw notFound('Account');
  const { rows: [n] } = await query('SELECT count(*) AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL', [u.id]);
  res.json({ ...publicUser(u), unreadNotifications: n.unread });
});

module.exports = { router, publicUser };
