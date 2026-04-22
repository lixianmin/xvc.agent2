import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createUser,
  getUser,
  updateUser,
  createTask,
  listTasks,
  updateTask,
  deleteTask,
  createThread,
  getThread,
  listThreads,
  deleteThread,
  saveMessage,
  loadMessages,
  createDocument,
  listDocuments,
  deleteDocument,
  insertChunk,
  searchFTS,
  insertChatMemory,
  updateChatMemory,
  renameDocument,
} from '../../../src/dao/d1';

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

describe('Task DAO', () => {
  let db: D1Database;
  let userId: number;

  beforeAll(async () => {
    db = env.DB;
    await db.exec(
      "CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')), priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')), created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')), updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')));",
    );
    const user = await createUser(db, { email: 'taskuser@example.com', name: 'TaskUser' });
    userId = user.id;
  });

  it('creates a task with defaults', async () => {
    const task = await createTask(db, { userId, title: 'My Task' });
    expect(task.id).toBeDefined();
    expect(task.title).toBe('My Task');
    expect(task.status).toBe('pending');
    expect(task.priority).toBe('medium');
    expect(task.description).toBeNull();
  });

  it('creates a task with all fields', async () => {
    const task = await createTask(db, {
      userId,
      title: 'Full Task',
      description: 'desc',
      priority: 'high',
    });
    expect(task.description).toBe('desc');
    expect(task.priority).toBe('high');
  });

  it('lists tasks ordered by newest first', async () => {
    const t1 = await createTask(db, { userId, title: 'First' });
    const t2 = await createTask(db, { userId, title: 'Second' });
    const tasks = await listTasks(db, userId);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    const myTasks = tasks.filter((t) => t.id === t1.id || t.id === t2.id);
    expect(myTasks[0].id).toBeGreaterThan(myTasks[1].id);
  });

  it('filters tasks by status', async () => {
    const t1 = await createTask(db, { userId, title: 'Pending' });
    const t2 = await createTask(db, { userId, title: 'ToProgress' });
    await updateTask(db, t2.id, { status: 'in_progress' });

    const all = await listTasks(db, userId);
    expect(all.some(t => t.id === t1.id && t.status === 'pending')).toBe(true);
    expect(all.some(t => t.id === t2.id && t.status === 'in_progress')).toBe(true);

    const pending = await listTasks(db, userId, 'pending');
    expect(pending.every(t => t.status === 'pending')).toBe(true);
    expect(pending.some(t => t.id === t1.id)).toBe(true);
    expect(pending.some(t => t.id === t2.id)).toBe(false);
  });

  it('updates task fields', async () => {
    const task = await createTask(db, { userId, title: 'ToUpdate' });
    const updated = await updateTask(db, task.id, {
      title: 'Updated',
      status: 'in_progress',
    });
    expect(updated.title).toBe('Updated');
    expect(updated.status).toBe('in_progress');
  });

  it('deletes a task', async () => {
    const task = await createTask(db, { userId, title: 'ToDelete' });
    const result = await deleteTask(db, task.id);
    expect(result).toBe(true);
    const tasks = await listTasks(db, userId);
    expect(tasks.find((t) => t.id === task.id)).toBeUndefined();
  });

  it('deleteTask returns false for non-existent', async () => {
    const result = await deleteTask(db, 99999);
    expect(result).toBe(false);
  });
});

describe('Thread DAO', () => {
  let db: D1Database;
  let userId: number;

  beforeAll(async () => {
    db = env.DB;
    await db.exec(
      "CREATE TABLE IF NOT EXISTS threads (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')), updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')));",
    );
    const user = await createUser(db, { email: 'convuser@example.com', name: 'ConvUser' });
    userId = user.id;
  });

  it('creates a thread', async () => {
    const thread = await createThread(db, { userId, title: 'Test Thread' });
    expect(thread.id).toBeDefined();
    expect(thread.title).toBe('Test Thread');
  });

  it('creates thread without title', async () => {
    const thread = await createThread(db, { userId });
    expect(thread.id).toBeDefined();
    expect(thread.title).toBeNull();
  });

  it('gets a thread by id', async () => {
    const thread = await createThread(db, { userId, title: 'GetThread' });
    const found = await getThread(db, thread.id);
    expect(found!.title).toBe('GetThread');
  });

  it('lists threads ordered by newest first', async () => {
    const c1 = await createThread(db, { userId, title: 'Thread1' });
    const c2 = await createThread(db, { userId, title: 'Thread2' });
    const myThreads = await listThreads(db, userId);
    const filtered = myThreads.filter((c) => c.id === c1.id || c.id === c2.id);
    expect(filtered[0].id).toBeGreaterThan(filtered[1].id);
  });

  it('deletes a thread', async () => {
    const thread = await createThread(db, { userId, title: 'ToDelete' });
    const result = await deleteThread(db, thread.id);
    expect(result).toBe(true);
    const found = await getThread(db, thread.id);
    expect(found).toBeNull();
  });

  it('deleteThread returns false for non-existent', async () => {
    const result = await deleteThread(db, 99999);
    expect(result).toBe(false);
  });
});

describe('Message DAO', () => {
  let db: D1Database;
  let userId: number;
  let threadId: number;

  beforeAll(async () => {
    db = env.DB;
    await db.exec(
      "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')), content TEXT NOT NULL, tool_calls TEXT, tool_call_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')));",
    );
    const user = await createUser(db, { email: 'msguser@example.com', name: 'MsgUser' });
    userId = user.id;
    const thread = await createThread(db, { userId, title: 'MsgThread' });
    threadId = thread.id;
  });

  it('saves and loads a user message', async () => {
    const msg = await saveMessage(db, {
      thread_id: threadId,
      role: 'user',
      content: 'Hello',
    });
    expect(msg.id).toBeDefined();
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Hello');
  });

  it('saves a message with tool_calls', async () => {
    const toolCalls = JSON.stringify([{ id: 'tc1', function: { name: 'search' } }]);
    const msg = await saveMessage(db, {
      thread_id: threadId,
      role: 'assistant',
      content: '',
      tool_calls: toolCalls,
    });
    expect(msg.tool_calls).toBe(toolCalls);
  });

  it('saves a tool message with tool_call_id', async () => {
    const msg = await saveMessage(db, {
      thread_id: threadId,
      role: 'tool',
      content: 'result data',
      tool_call_id: 'tc1',
    });
    expect(msg.tool_call_id).toBe('tc1');
  });

  it('loadMessages returns messages in chronological order', async () => {
    const thread = await createThread(db, { userId, title: 'OrderThread' });
    await saveMessage(db, { thread_id: thread.id, role: 'user', content: 'A'.repeat(100) });
    await saveMessage(db, { thread_id: thread.id, role: 'assistant', content: 'B'.repeat(100) });
    await saveMessage(db, { thread_id: thread.id, role: 'user', content: 'C'.repeat(100) });
    const msgs = await loadMessages(db, thread.id);
    expect(msgs.length).toBe(3);
    expect(msgs[0].content[0]).toBe('A');
    expect(msgs[1].content[0]).toBe('B');
    expect(msgs[2].content[0]).toBe('C');
  });

  it('loadMessages respects token budget', async () => {
    const thread = await createThread(db, { userId, title: 'BudgetThread' });
    const bigContent = 'X'.repeat(4000);
    await saveMessage(db, { thread_id: thread.id, role: 'user', content: bigContent });
    await saveMessage(db, { thread_id: thread.id, role: 'assistant', content: bigContent });
    await saveMessage(db, { thread_id: thread.id, role: 'user', content: 'short' });
    await saveMessage(db, { thread_id: thread.id, role: 'assistant', content: 'short reply' });
    const msgs = await loadMessages(db, thread.id, 100);
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('short');
    expect(msgs[1].role).toBe('assistant');
  });

  it('loadMessages keeps complete tool_call chains', async () => {
    const thread = await createThread(db, { userId, title: 'ChainThread' });
    await saveMessage(db, { thread_id: thread.id, role: 'user', content: 'A'.repeat(2000) });
    const assistant = await saveMessage(db, {
      thread_id: thread.id,
      role: 'assistant',
      content: '',
      tool_calls: JSON.stringify([{ id: 'call_1' }]),
    });
    const tool = await saveMessage(db, {
      thread_id: thread.id,
      role: 'tool',
      content: 'A'.repeat(2000),
      tool_call_id: 'call_1',
    });
    await saveMessage(db, { thread_id: thread.id, role: 'user', content: 'latest' });
    await saveMessage(db, { thread_id: thread.id, role: 'assistant', content: 'reply' });

    const msgs = await loadMessages(db, thread.id, 200);
    const ids = msgs.map((m) => m.id);
    if (ids.includes(assistant.id)) {
      expect(ids).toContain(tool.id);
    }
    if (ids.includes(tool.id)) {
      expect(ids).toContain(assistant.id);
    }
  });

  it('cascade deletes messages when thread deleted', async () => {
    const thread = await createThread(db, { userId, title: 'CascadeThread' });
    await saveMessage(db, { thread_id: thread.id, role: 'user', content: 'will be deleted' });
    await deleteThread(db, thread.id);
    const msgs = await loadMessages(db, thread.id);
    expect(msgs.length).toBe(0);
  });

  it('loadMessages returns empty array for non-existent thread', async () => {
    const msgs = await loadMessages(db, 99999);
    expect(msgs).toEqual([]);
  });
});

describe('Document & Chunk DAO', () => {
  let db: D1Database;
  let userId: number;
  let docId: number;

  beforeAll(async () => {
    db = env.DB;
    await db.exec(
      "CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, r2_key TEXT NOT NULL, hash TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')));",
    );
    await db.exec(
      "CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0, content TEXT NOT NULL, token_count INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'document', expires_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')));",
    );
    await db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, tokenize='porter unicode61', content='chunks', content_rowid='id');",
    );
    await db.exec(
      "CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content); END;",
    );
    const user = await createUser(db, { email: 'docuser@example.com', name: 'DocUser' });
    userId = user.id;
  });

  it('creates a document', async () => {
    const doc = await createDocument(db, {
      userId,
      filename: 'test.pdf',
      mimeType: 'application/pdf',
      size: 1024,
      r2Key: 'uploads/test.pdf',
      hash: 'abc123',
    });
    expect(doc.id).toBeDefined();
    expect(doc.filename).toBe('test.pdf');
    expect(doc.mime_type).toBe('application/pdf');
    expect(doc.size).toBe(1024);
    expect(doc.r2_key).toBe('uploads/test.pdf');
    expect(doc.hash).toBe('abc123');
    docId = doc.id;
  });

  it('lists documents for a user', async () => {
    const docs = await listDocuments(db, userId);
    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs.find((d) => d.id === docId)).toBeDefined();
  });

  it('inserts a chunk and syncs FTS', async () => {
    const chunk = await insertChunk(db, {
      docId,
      userId,
      seq: 1,
      content: '人工智能是计算机科学的一个分支',
      tokenCount: 10,
    });
    expect(chunk.id).toBeDefined();
    expect(chunk.doc_id).toBe(docId);
    expect(chunk.seq).toBe(1);
    expect(chunk.content).toBe('人工智能是计算机科学的一个分支');
    expect(chunk.token_count).toBe(10);
  });

  it('searchFTS finds CJK content', async () => {
    const results = await searchFTS(db, '人工智能', 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain('人工智能');
    expect(typeof results[0].score).toBe('number');
  });

  it('searchFTS returns empty for no match', async () => {
    const results = await searchFTS(db, 'xyznonexistent123', 10);
    expect(results).toEqual([]);
  });

  it('deletes a document and cascades chunks', async () => {
    const doc = await createDocument(db, {
      userId,
      filename: 'del.pdf',
      mimeType: 'application/pdf',
      size: 512,
      r2Key: 'uploads/del.pdf',
      hash: 'del456',
    });
    await insertChunk(db, { docId: doc.id, userId, seq: 1, content: 'to be deleted', tokenCount: 3 });
    const result = await deleteDocument(db, doc.id);
    expect(result).toBe(true);
    const docs = await listDocuments(db, userId);
    expect(docs.find((d) => d.id === doc.id)).toBeUndefined();

    const remainingChunks = await db.prepare('SELECT COUNT(*) as cnt FROM chunks WHERE doc_id = ?').bind(doc.id).first<{ cnt: number }>();
    expect(remainingChunks!.cnt).toBe(0);
  });

  it('deleteDocument cleans up FTS entries for deleted chunks', async () => {
    const doc = await createDocument(db, {
      userId,
      filename: 'fts-cleanup.txt',
      mimeType: 'text/plain',
      size: 100,
      r2Key: 'uploads/fts-cleanup.txt',
      hash: 'fts-del-001',
    });
    const chunk = await insertChunk(db, { docId: doc.id, userId, seq: 1, content: 'unique FTS cleanup test content xyz789', tokenCount: 6 });

    const before = await searchFTS(db, 'xyz789', userId);
    expect(before.length).toBeGreaterThanOrEqual(1);
    expect(before[0].id).toBe(chunk.id);

    await deleteDocument(db, doc.id);

    const after = await searchFTS(db, 'xyz789', userId);
    expect(after.find(r => r.id === chunk.id)).toBeUndefined();
  });

  it('FTS trigger removes index when chunk is directly deleted', async () => {
    const doc = await createDocument(db, {
      userId,
      filename: 'trigger-test.pdf',
      mimeType: 'application/pdf',
      size: 256,
      r2Key: 'uploads/trigger.pdf',
      hash: 'trigger789',
    });
    const chunk = await insertChunk(db, {
      docId: doc.id,
      userId,
      seq: 1,
      content: '触发器测试内容搜索关键词',
      tokenCount: 10,
    });

    const beforeDelete = await searchFTS(db, '触发器测试', 10);
    expect(beforeDelete.length).toBeGreaterThanOrEqual(1);

    await db.prepare('DELETE FROM chunks WHERE id = ?').bind(chunk.id).run();

    const afterDelete = await searchFTS(db, '触发器测试', 10);
    expect(afterDelete.find((r) => r.id === chunk.id)).toBeUndefined();

    await deleteDocument(db, doc.id);
  });

  it('deleteDocument returns false for non-existent', async () => {
    const result = await deleteDocument(db, 99999);
    expect(result).toBe(false);
  });

  it('renames a document', async () => {
    const doc = await createDocument(db, {
      userId,
      filename: 'original.txt',
      mimeType: 'text/plain',
      size: 100,
      r2Key: 'uploads/original.txt',
      hash: 'rename1',
    });
    const updated = await renameDocument(db, doc.id, 'renamed.txt');
    expect(updated.filename).toBe('renamed.txt');
    expect(updated.id).toBe(doc.id);

    await deleteDocument(db, doc.id);
  });

  it('inserts a chat memory with source=chat', async () => {
    const chunk = await insertChatMemory(db, {
      userId,
      content: '用户偏好用中文交流',
      category: 'preference',
    });
    expect(chunk).toBeTruthy();
    expect(chunk!.source).toBe('chat');
    expect(chunk!.doc_id).toBeNull();
    expect(chunk!.content).toBe('用户偏好用中文交流');
    expect(chunk!.expires_at).toBeTruthy();
  });

  it('inserts a fact memory with no expiration', async () => {
    const chunk = await insertChatMemory(db, {
      userId,
      content: '用户名叫小明',
      category: 'fact',
    });
    expect(chunk!.expires_at).toBeNull();
  });

  it('updates chat memory content and refreshes expiration', async () => {
    const chunk = await insertChatMemory(db, {
      userId,
      content: '用户喜欢 Python',
      category: 'preference',
    });
    const updated = await updateChatMemory(db, chunk!.id, {
      content: '用户喜欢 TypeScript',
      category: 'fact',
    });
    expect(updated).toBeTruthy();
    const row = await db.prepare('SELECT content, source, expires_at FROM chunks WHERE id = ?').bind(chunk!.id).first<any>();
    expect(row.content).toBe('用户喜欢 TypeScript');
    expect(row.expires_at).toBeNull();
  });

  it('searchFTS excludes expired chat memories', async () => {
    await insertChatMemory(db, { userId, content: '过期记忆关键词唯一标识xyz999', category: 'plan' });
    await db.prepare("UPDATE chunks SET expires_at = datetime('now', '+8 hours', '-1 day') WHERE source = 'chat'").run();
    const results = await searchFTS(db, '过期记忆关键词唯一标识xyz999', 10);
    expect(results.length).toBe(0);
  });

  it('searchFTS filters by user_id', async () => {
    const userA = await createUser(db, { email: 'ftsa@example.com', name: 'A' });
    const userB = await createUser(db, { email: 'ftsb@example.com', name: 'B' });
    const docA = await createDocument(db, {
      userId: userA.id, filename: 'a.txt', mimeType: 'text/plain',
      size: 10, r2Key: 'a', hash: 'ftsa',
    });
    const docB = await createDocument(db, {
      userId: userB.id, filename: 'b.txt', mimeType: 'text/plain',
      size: 10, r2Key: 'b', hash: 'ftsb',
    });
    await insertChunk(db, { docId: docA.id, userId: userA.id, seq: 1, content: '唯一搜索词麒麟甲', tokenCount: 5 });
    await insertChunk(db, { docId: docB.id, userId: userB.id, seq: 1, content: '唯一搜索词麒麟乙', tokenCount: 5 });

    const resultsA = await searchFTS(db, '麒麟', 10, userA.id);
    expect(resultsA.every(r => r.doc_id === docA.id)).toBe(true);

    const resultsB = await searchFTS(db, '麒麟', 10, userB.id);
    expect(resultsB.every(r => r.doc_id === docB.id)).toBe(true);
  });

  it('searchFTS includes non-expired chat memories', async () => {
    await insertChatMemory(db, { userId, content: '有效记忆关键词唯一标识abc888', category: 'fact' });
    const results = await searchFTS(db, '有效记忆关键词唯一标识abc888', 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
