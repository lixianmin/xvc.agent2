import { Hono } from 'hono';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authMiddleware } from '../../../src/middleware/auth';

vi.mock('../../../src/dao/d1', () => ({
  getUser: vi.fn(),
}));

import { getUser } from '../../../src/dao/d1';

const mockedGetUser = vi.mocked(getUser);

const env = { DB: {} as unknown as D1Database };

function createApp() {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.get('/test', (c) => c.json({ ok: true, userId: c.get('user').id }));
  return app;
}

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes through with valid X-User-Id', async () => {
    const app = createApp();
    mockedGetUser.mockResolvedValue({ id: 1, email: 'a@b.com', name: 'Test', ai_nickname: null, created_at: '2025-01-01' });

    const res = await app.request(
      '/test',
      { headers: { 'X-User-Id': '1' } },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.userId).toBe(1);
    expect(mockedGetUser).toHaveBeenCalledWith(env.DB, 1);
  });

  it('returns 401 for missing X-User-Id header', async () => {
    const app = createApp();

    const res = await app.request('/test', undefined, env);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Missing X-User-Id');
  });

  it('returns 401 for non-numeric user ID', async () => {
    const app = createApp();

    const res = await app.request(
      '/test',
      { headers: { 'X-User-Id': 'abc' } },
      env,
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid user ID');
  });

  it('returns 401 for non-existent user', async () => {
    const app = createApp();
    mockedGetUser.mockResolvedValue(null);

    const res = await app.request(
      '/test',
      { headers: { 'X-User-Id': '99999' } },
      env,
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('User not found');
  });
});
