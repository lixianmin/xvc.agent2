import type { Context, Next } from 'hono';
import { getUser } from '../dao/d1';

export const authMiddleware = async (c: Context, next: Next) => {
  const userId = c.req.header('X-User-Id') || c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing X-User-Id' }, 401);
  const parsed = parseInt(userId);
  if (isNaN(parsed)) return c.json({ error: 'Invalid user ID' }, 401);
  const user = await getUser(c.env.DB, parsed);
  if (!user) return c.json({ error: 'User not found' }, 401);
  c.set('user', user);
  await next();
};
