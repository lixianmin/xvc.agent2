import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createUser } from '../../../src/dao/d1';

const mockStream = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"type":"text","content":"hi"}\n\n'));
    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    controller.close();
  },
});

vi.mock('../../../src/agent/loop', () => ({
  AgentLoop: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockReturnValue(mockStream),
  })),
}));

vi.mock('../../../src/llm/client', () => ({
  LLMClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/llm/embedding', () => ({
  EmbeddingClient: vi.fn().mockImplementation(() => ({
    embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
  })),
}));

vi.mock('../../../src/dao/qdrant', () => ({
  QdrantDAO: vi.fn().mockImplementation(() => ({
    upsertVectors: vi.fn().mockResolvedValue(undefined),
    ensureCollection: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../src/services/parser', () => ({
  parseFile: vi.fn().mockResolvedValue('hello world'),
}));

let app: any;

function testEnv() {
  return {
    DB: env.DB,
    FILES: { put: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket,
    GLM_API_KEY: 'test',
    SILICONFLOW_API_KEY: 'test',
    QDRANT_URL: 'http://localhost:6333',
    QDRANT_API_KEY: 'test',
    QDRANT_COLLECTION: 'test_chunks',
    SERPER_API_KEY: 'test',
  };
}

beforeAll(async () => {
  const db = env.DB as D1Database;
  await db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, ai_nickname TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')));");
  await db.exec("CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')), priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')), created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')), updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')));");
  await db.exec("CREATE TABLE IF NOT EXISTS threads (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')), updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')));");
  await db.exec("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')), content TEXT NOT NULL, tool_calls TEXT, tool_call_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')));");
  await db.exec("CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, r2_key TEXT NOT NULL, hash TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')));");
  await db.exec("CREATE TABLE IF NOT EXISTS outbox_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL CHECK (event_type IN ('embed_chunk', 'delete_vector')), chunk_id INTEGER NOT NULL, payload TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')), attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')), updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')));");
  await db.exec('CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0, content TEXT NOT NULL, token_count INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT \'document\', expires_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime(\'now\', \'+8 hours\')));');
  await db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, tokenize='porter unicode61', content='chunks', content_rowid='id');");
  await db.exec("CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content); END;");

  const mod = await import('../../../src/index');
  app = mod.default;
});

describe('POST /api/user/create', () => {
  it('creates a user and returns it', async () => {
    const res = await app.request('/api/user/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'route@test.com', name: 'RouteUser' }),
    }, testEnv());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe('route@test.com');
    expect(body.name).toBe('RouteUser');
    expect(body.id).toBeDefined();
  });
});

describe('GET /api/user', () => {
  it('returns user by id', async () => {
    const user = await createUser(env.DB as D1Database, { email: 'getuser@test.com', name: 'GetUser' });

    const res = await app.request(`/api/user?id=${user.id}`, {
      headers: { 'X-User-Id': String(user.id) },
    }, testEnv());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(user.id);
    expect(body.email).toBe('getuser@test.com');
  });

  it('returns 400 when id is not a number', async () => {
    const res = await app.request('/api/user?id=abc', {
      headers: { 'X-User-Id': '1' },
    }, testEnv());

    expect(res.status).toBe(400);
  });

  it('returns 400 when id is empty', async () => {
    const res = await app.request('/api/user?id=', {
      headers: { 'X-User-Id': '1' },
    }, testEnv());

    expect(res.status).toBe(400);
  });
});

describe('Auth middleware', () => {
  it('blocks unauthenticated requests to protected routes', async () => {
    const res = await app.request('/api/tasks/list', {}, testEnv());

    expect(res.status).toBe(401);
  });
});

describe('POST /api/chat', () => {
  it('returns SSE stream', async () => {
    const db = env.DB as D1Database;
    const user = await createUser(db, { email: 'chat@test.com', name: 'ChatUser' });
    const { createThread } = await import('../../../src/dao/d1');
    const thread = await createThread(db, { userId: user.id, title: 'Chat' });

    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': String(user.id),
      },
      body: JSON.stringify({ threadId: thread.id, content: 'Hello' }),
    }, testEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');

    const text = await res.text();
    expect(text).toContain('data:');
  }, 15_000);

  it('returns 400 when threadId is not a number', async () => {
    const db = env.DB as D1Database;
    const user = await createUser(db, { email: 'chatnan@test.com', name: 'ChatNaN' });

    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': String(user.id),
      },
      body: JSON.stringify({ threadId: 'abc', content: 'Hello' }),
    }, testEnv());

    expect(res.status).toBe(400);
  });
});

describe('POST /api/tasks/create', () => {
  it('creates a task', async () => {
    const db = env.DB as D1Database;
    const user = await createUser(db, { email: 'task@test.com', name: 'TaskUser' });

    const res = await app.request('/api/tasks/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': String(user.id),
      },
      body: JSON.stringify({ userId: user.id, title: 'Test Task' }),
    }, testEnv());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe('Test Task');
    expect(body.status).toBe('pending');
  });
});

describe('GET /api/tasks/list', () => {
  it('returns tasks for user', async () => {
    const db = env.DB as D1Database;
    const user = await createUser(db, { email: 'list@test.com', name: 'ListUser' });
    const { createTask } = await import('../../../src/dao/d1');
    await createTask(db, { userId: user.id, title: 'ListTask' });

    const res = await app.request(`/api/tasks/list?userId=${user.id}`, {
      headers: { 'X-User-Id': String(user.id) },
    }, testEnv());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((t: any) => t.title === 'ListTask')).toBe(true);
  });

  it('returns 400 when userId is not a number', async () => {
    const res = await app.request('/api/tasks/list?userId=abc', {
      headers: { 'X-User-Id': '1' },
    }, testEnv());

    expect(res.status).toBe(400);
  });
});

describe('POST /api/files/upload', () => {
  it('processes file upload', async () => {
    const db = env.DB as D1Database;
    const user = await createUser(db, { email: 'upload@test.com', name: 'UploadUser' });

    const formData = new FormData();
    formData.append('file', new File(['hello world'], 'test.txt', { type: 'text/plain' }));

    const res = await app.request('/api/files/upload', {
      method: 'POST',
      headers: { 'X-User-Id': String(user.id) },
      body: formData,
    }, testEnv());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filename).toBeDefined();
  });

  it('rejects unsupported file type', async () => {
    const db = env.DB as D1Database;
    const user = await createUser(db, { email: 'upload-bad-ext@test.com', name: 'BadExt' });

    const formData = new FormData();
    formData.append('file', new File(['<html></html>'], 'evil.exe', { type: 'application/x-msdownload' }));

    const res = await app.request('/api/files/upload', {
      method: 'POST',
      headers: { 'X-User-Id': String(user.id) },
      body: formData,
    }, testEnv());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Unsupported');
  });

  it('rejects file exceeding size limit', async () => {
    const db = env.DB as D1Database;
    const user = await createUser(db, { email: 'upload-big@test.com', name: 'BigFile' });

    const bigContent = new Uint8Array(21 * 1024 * 1024);
    const formData = new FormData();
    formData.append('file', new File([bigContent], 'big.pdf', { type: 'application/pdf' }));

    const res = await app.request('/api/files/upload', {
      method: 'POST',
      headers: { 'X-User-Id': String(user.id) },
      body: formData,
    }, testEnv());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('too large');
  });

  it('rejects missing file', async () => {
    const db = env.DB as D1Database;
    const user = await createUser(db, { email: 'upload-nofile@test.com', name: 'NoFile' });

    const formData = new FormData();
    const res = await app.request('/api/files/upload', {
      method: 'POST',
      headers: { 'X-User-Id': String(user.id) },
      body: formData,
    }, testEnv());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('rejects image exceeding 10MB limit', async () => {
    const db = env.DB as D1Database;
    const user = await createUser(db, { email: `bigimg${Date.now()}@test.com`, name: 'BigImg' });
    const bigContent = new Uint8Array(11 * 1024 * 1024);
    const formData = new FormData();
    formData.append('file', new File([bigContent], 'big.jpg', { type: 'image/jpeg' }));

    const res = await app.request('/api/files/upload', {
      method: 'POST',
      headers: { 'X-User-Id': String(user.id) },
      body: formData,
    }, testEnv());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Image too large');
  });

  it('rejects unsupported image format bmp', async () => {
    const db = env.DB as D1Database;
    const user = await createUser(db, { email: `bmp${Date.now()}@test.com`, name: 'BmpUser' });
    const formData = new FormData();
    formData.append('file', new File(['data'], 'photo.bmp', { type: 'image/bmp' }));

    const res = await app.request('/api/files/upload', {
      method: 'POST',
      headers: { 'X-User-Id': String(user.id) },
      body: formData,
    }, testEnv());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Unsupported');
  });
});

describe('GET /api/admin/outbox-status', () => {
  it('returns outbox status counts', async () => {
    const db = env.DB as D1Database;
    const user = await createUser(db, { email: 'admin@test.com', name: 'AdminUser' });
    const { createDocument } = await import('../../../src/dao/d1');
    await createDocument(db, {
      userId: user.id, filename: 'outbox.txt', mimeType: 'text/plain',
      size: 10, r2Key: 'test', hash: 'h1',
    });

    const res = await app.request('/api/admin/outbox-status', {
      headers: { 'X-User-Id': String(user.id) },
    }, testEnv());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('pending');
    expect(body).toHaveProperty('completed');
    expect(body).toHaveProperty('failed');
    expect(body).toHaveProperty('processing');
  });
});

describe('Authorization: ownership checks', () => {
  let counter = Date.now();
  function uid() { return ++counter; }

  async function setupTwoUsers() {
    const db = env.DB as D1Database;
    const n = uid();
    const userA = await createUser(db, { email: `auth-a${n}@test.com`, name: 'AuthA' });
    const userB = await createUser(db, { email: `auth-b${n}@test.com`, name: 'AuthB' });
    return { db, userA, userB };
  }

  it('tasks/delete rejects if task belongs to another user', async () => {
    const { db, userA, userB } = await setupTwoUsers();
    const { createTask } = await import('../../../src/dao/d1');
    const task = await createTask(db, { userId: userA.id, title: 'Private Task' });

    const res = await app.request('/api/tasks/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': String(userB.id) },
      body: JSON.stringify({ id: task.id }),
    }, testEnv());

    expect(res.status).toBe(403);
  });

  it('tasks/update rejects if task belongs to another user', async () => {
    const { db, userA, userB } = await setupTwoUsers();
    const { createTask } = await import('../../../src/dao/d1');
    const task = await createTask(db, { userId: userA.id, title: 'Private Task' });

    const res = await app.request('/api/tasks/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': String(userB.id) },
      body: JSON.stringify({ id: task.id, title: 'Hacked' }),
    }, testEnv());

    expect(res.status).toBe(403);
  });

  it('threads/delete rejects if thread belongs to another user', async () => {
    const { db, userA, userB } = await setupTwoUsers();
    const { createThread } = await import('../../../src/dao/d1');
    const thread = await createThread(db, { userId: userA.id, title: 'Private' });

    const res = await app.request('/api/threads/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': String(userB.id) },
      body: JSON.stringify({ id: thread.id }),
    }, testEnv());

    expect(res.status).toBe(403);
  });

  it('threads/update-title rejects if thread belongs to another user', async () => {
    const { db, userA, userB } = await setupTwoUsers();
    const { createThread } = await import('../../../src/dao/d1');
    const thread = await createThread(db, { userId: userA.id, title: 'Private' });

    const res = await app.request('/api/threads/update-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': String(userB.id) },
      body: JSON.stringify({ id: thread.id, title: 'Hacked' }),
    }, testEnv());

    expect(res.status).toBe(403);
  });

  it('threads/messages rejects if thread belongs to another user', async () => {
    const { db, userA, userB } = await setupTwoUsers();
    const { createThread } = await import('../../../src/dao/d1');
    const thread = await createThread(db, { userId: userA.id, title: 'Private' });

    const res = await app.request(`/api/threads/messages?id=${thread.id}`, {
      headers: { 'X-User-Id': String(userB.id) },
    }, testEnv());

    expect(res.status).toBe(403);
  });

  it('files/delete rejects if document belongs to another user', async () => {
    const { db, userA, userB } = await setupTwoUsers();
    const { createDocument } = await import('../../../src/dao/d1');
    const doc = await createDocument(db, {
      userId: userA.id, filename: 'secret.txt', mimeType: 'text/plain',
      size: 100, r2Key: 'secret', hash: 'h1',
    });

    const res = await app.request('/api/files/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': String(userB.id) },
      body: JSON.stringify({ id: doc.id }),
    }, testEnv());

    expect(res.status).toBe(403);
  });

  it('tasks/delete succeeds for own task', async () => {
    const { db, userA } = await setupTwoUsers();
    const { createTask } = await import('../../../src/dao/d1');
    const task = await createTask(db, { userId: userA.id, title: 'My Task' });

    const res = await app.request('/api/tasks/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': String(userA.id) },
      body: JSON.stringify({ id: task.id }),
    }, testEnv());

    expect(res.status).toBe(200);
  });

  it('user/update rejects if updating another user', async () => {
    const { userA, userB } = await setupTwoUsers();

    const res = await app.request('/api/user/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': String(userB.id) },
      body: JSON.stringify({ id: userA.id, name: 'Hacked' }),
    }, testEnv());

    expect(res.status).toBe(403);
  });

  it('user/update succeeds for own user', async () => {
    const { userA } = await setupTwoUsers();

    const res = await app.request('/api/user/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': String(userA.id) },
      body: JSON.stringify({ id: userA.id, name: 'NewName' }),
    }, testEnv());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('NewName');
  });
});

describe('POST /api/files/rename', () => {
  let counter = Date.now();
  function uid() { return ++counter; }

  it('renames a file', async () => {
    const db = env.DB as D1Database;
    const n = uid();
    const user = await createUser(db, { email: `rename${n}@test.com`, name: 'RenameUser' });
    const { createDocument } = await import('../../../src/dao/d1');
    const doc = await createDocument(db, {
      userId: user.id, filename: 'old.txt', mimeType: 'text/plain',
      size: 10, r2Key: 'test', hash: `h${n}`,
    });

    const res = await app.request('/api/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': String(user.id) },
      body: JSON.stringify({ id: doc.id, filename: 'new.txt' }),
    }, testEnv());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filename).toBe('new.txt');
  });

  it('rejects rename of another users file', async () => {
    const db = env.DB as D1Database;
    const n = uid();
    const userA = await createUser(db, { email: `rename-a${n}@test.com`, name: 'A' });
    const userB = await createUser(db, { email: `rename-b${n}@test.com`, name: 'B' });
    const { createDocument } = await import('../../../src/dao/d1');
    const doc = await createDocument(db, {
      userId: userA.id, filename: 'secret.txt', mimeType: 'text/plain',
      size: 10, r2Key: 'secret', hash: `hs${n}`,
    });

    const res = await app.request('/api/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': String(userB.id) },
      body: JSON.stringify({ id: doc.id, filename: 'hacked.txt' }),
    }, testEnv());

    expect(res.status).toBe(403);
  });
});
