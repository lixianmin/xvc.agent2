import type { Context, Next } from 'hono';

type OwnerIdFn = (db: D1Database, id: number) => Promise<number | null>;
type GetIdFn = (c: Context) => number | null | Promise<number | null>;

export function createOwnershipCheck(getId: GetIdFn, getOwnerId: OwnerIdFn) {
  return async (c: Context, next: Next) => {
    const id = await getId(c);
    if (id === null) return c.json({ error: 'Invalid id' }, 400);

    const user = c.get('user') as { id: number };
    const ownerId = await getOwnerId(c.env.DB as D1Database, id);
    if (ownerId === null) return c.json({ error: 'Resource not found' }, 404);
    if (ownerId !== user.id) return c.json({ error: 'Forbidden' }, 403);

    await next();
  };
}

export function createBodyOwnershipCheck<T extends Record<string, unknown>>(
  extractId: (body: T) => number | null,
  getOwnerId: OwnerIdFn,
) {
  return async (c: Context, next: Next) => {
    const body = await c.req.json<T>();
    c.set('parsedBody' as never, body as never);

    const id = extractId(body);
    if (id === null) return c.json({ error: 'Invalid id' }, 400);

    const user = c.get('user') as { id: number };
    const ownerId = await getOwnerId(c.env.DB as D1Database, id);
    if (ownerId === null) return c.json({ error: 'Resource not found' }, 404);
    if (ownerId !== user.id) return c.json({ error: 'Forbidden' }, 403);

    await next();
  };
}
