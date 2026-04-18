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
  await db.exec("CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, r2_key TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')));");
  await db.exec("CREATE TABLE IF NOT EXISTS outbox_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL CHECK (event_type IN ('embed_chunk', 'delete_vector')), chunk_id INTEGER NOT NULL, payload TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')), attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')), updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')));");
  await db.exec('CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0, content TEXT NOT NULL, token_count INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT \'document\', expires_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime(\'now\', \'+8 hours\')));');
  await db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, tokenize='porter unicode61', content='chunks', content_rowid='id');");

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
});

describe('Auth middleware', () => {
  it('blocks unauthenticated requests to protected routes', async () => {
    const res = await app.request('/api/tasks/list?userId=1', {}, testEnv());

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
