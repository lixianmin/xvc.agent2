import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { createUser, getUser, updateUser } from '../../../src/dao/d1';

describe('User DAO', () => {
  let db: D1Database;

  beforeAll(async () => {
    db = env.DB;
    await db.exec(
      "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, ai_nickname TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')));",
    );
  });

  it('creates a user and retrieves by id', async () => {
    const user = await createUser(db, { email: 'test@example.com', name: 'Test' });
    expect(user.id).toBeDefined();
    expect(user.email).toBe('test@example.com');
    const found = await getUser(db, user.id);
    expect(found!.name).toBe('Test');
  });

  it('rejects duplicate email', async () => {
    await createUser(db, { email: 'dup@example.com', name: 'A' });
    await expect(createUser(db, { email: 'dup@example.com', name: 'B' }))
      .rejects.toThrow();
  });

  it('updates user nickname', async () => {
    const user = await createUser(db, { email: 'nick@example.com', name: 'X' });
    await updateUser(db, user.id, { ai_nickname: '小助手' });
    const found = await getUser(db, user.id);
    expect(found!.ai_nickname).toBe('小助手');
  });

  it('returns null for non-existent user', async () => {
    const found = await getUser(db, 99999);
    expect(found).toBeNull();
  });
});
