import { tokenizeCJK } from '../services/cjk';
import { estimateTokens } from '../services/chunker';

type CreateUserInput = {
  email: string;
  name: string;
};

type UpdateUserInput = {
  name?: string;
  ai_nickname?: string;
};

type User = {
  id: number;
  email: string;
  name: string;
  ai_nickname: string | null;
  created_at: string;
};

export async function createUser(db: D1Database, input: CreateUserInput): Promise<User> {
  const result = await db
    .prepare('INSERT INTO users (email, name) VALUES (?, ?)')
    .bind(input.email, input.name)
    .run();
  const id = result.meta.last_row_id as number;
  const user = await getUser(db, id);
  return user!;
}

export async function getUser(db: D1Database, id: number): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
}

export async function updateUser(db: D1Database, id: number, input: UpdateUserInput): Promise<User> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) {
    sets.push('name = ?');
    values.push(input.name);
  }
  if (input.ai_nickname !== undefined) {
    sets.push('ai_nickname = ?');
    values.push(input.ai_nickname);
  }
  if (sets.length === 0) {
    return (await getUser(db, id))!;
  }
  values.push(id);
  await db
    .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
  return (await getUser(db, id))!;
}

type Task = {
  id: number;
  user_id: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  created_at: string;
  updated_at: string;
};

type CreateTaskInput = {
  userId: number;
  title: string;
  description?: string;
  priority?: string;
};

type UpdateTaskInput = {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
};

export async function createTask(db: D1Database, input: CreateTaskInput): Promise<Task> {
  const priority = input.priority ?? 'medium';
  const result = await db
    .prepare('INSERT INTO tasks (user_id, title, description, priority) VALUES (?, ?, ?, ?)')
    .bind(input.userId, input.title, input.description ?? null, priority)
    .run();
  const id = result.meta.last_row_id as number;
  return db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<Task>()!;
}

export async function listTasks(db: D1Database, userId: number, status?: string): Promise<Task[]> {
  if (status) {
    const result = await db
      .prepare('SELECT * FROM tasks WHERE user_id = ? AND status = ? ORDER BY id DESC')
      .bind(userId, status)
      .all<Task>();
    return result.results;
  }
  const result = await db
    .prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY id DESC')
    .bind(userId)
    .all<Task>();
  return result.results;
}

export async function updateTask(db: D1Database, id: number, input: UpdateTaskInput): Promise<Task> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.title !== undefined) {
    sets.push('title = ?');
    values.push(input.title);
  }
  if (input.description !== undefined) {
    sets.push('description = ?');
    values.push(input.description);
  }
  if (input.status !== undefined) {
    sets.push('status = ?');
    values.push(input.status);
  }
  if (input.priority !== undefined) {
    sets.push('priority = ?');
    values.push(input.priority);
  }
  if (sets.length > 0) {
    sets.push("updated_at = datetime('now', '+8 hours')");
    values.push(id);
    await db
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }
  return db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<Task>()!;
}

export async function deleteTask(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
  return result.meta.changes > 0;
}

export async function getTaskOwnerId(db: D1Database, id: number): Promise<number | null> {
  const row = await db.prepare('SELECT user_id FROM tasks WHERE id = ?').bind(id).first<{ user_id: number }>();
  return row?.user_id ?? null;
}

type Thread = {
  id: number;
  user_id: number;
  title: string | null;
  created_at: string;
  updated_at: string;
};

type CreateThreadInput = {
  userId: number;
  title?: string;
};

export async function createThread(db: D1Database, input: CreateThreadInput): Promise<Thread> {
  const result = await db
    .prepare('INSERT INTO threads (user_id, title) VALUES (?, ?)')
    .bind(input.userId, input.title ?? null)
    .run();
  const id = result.meta.last_row_id as number;
  return db.prepare('SELECT * FROM threads WHERE id = ?').bind(id).first<Thread>()!;
}

export async function getThread(db: D1Database, id: number): Promise<Thread | null> {
  return db.prepare('SELECT * FROM threads WHERE id = ?').bind(id).first<Thread>();
}

export async function listThreads(db: D1Database, userId: number): Promise<Thread[]> {
  const result = await db
    .prepare('SELECT * FROM threads WHERE user_id = ? ORDER BY id DESC')
    .bind(userId)
    .all<Thread>();
  return result.results;
}

export async function deleteThread(db: D1Database, id: number): Promise<boolean> {
  const result = await db.batch([
    db.prepare('DELETE FROM messages WHERE thread_id = ?').bind(id),
    db.prepare('DELETE FROM threads WHERE id = ?').bind(id),
  ]);
  return result[1].meta.changes > 0;
}

export async function updateThreadTitle(db: D1Database, id: number, title: string): Promise<void> {
  await db.prepare('UPDATE threads SET title = ? WHERE id = ?').bind(title, id).run();
}

export async function getThreadOwnerId(db: D1Database, id: number): Promise<number | null> {
  const row = await db.prepare('SELECT user_id FROM threads WHERE id = ?').bind(id).first<{ user_id: number }>();
  return row?.user_id ?? null;
}

type Message = {
  id: number;
  thread_id: number;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  created_at: string;
};

type SaveMessageInput = {
  thread_id: number;
  role: string;
  content: string;
  tool_calls?: string;
  tool_call_id?: string;
};

export async function saveMessage(db: D1Database, input: SaveMessageInput): Promise<Message> {
  const result = await db.batch([
    db.prepare('INSERT INTO messages (thread_id, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?)')
      .bind(input.thread_id, input.role, input.content, input.tool_calls ?? null, input.tool_call_id ?? null),
    db.prepare("UPDATE threads SET updated_at = datetime('now', '+8 hours') WHERE id = ?").bind(input.thread_id),
  ]);
  const id = result[0].meta.last_row_id as number;
  return db.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first<Message>()!;
}

type ToolCallInfo = { id: string };

function getToolCallIds(msg: Message): Set<string> {
  if (!msg.tool_calls) return new Set();
  try {
    const calls: ToolCallInfo[] = JSON.parse(msg.tool_calls);
    return new Set(calls.map((c) => c.id));
  } catch {
    return new Set();
  }
}

export async function loadMessages(db: D1Database, threadId: number, tokenBudget = 8000): Promise<Message[]> {
  const result = await db
    .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC')
    .bind(threadId)
    .all<Message>();
  const messages = result.results;
  if (messages.length === 0) return [];

  const groups = buildMessageGroups(messages);

  let tokenCount = 0;
  const selectedGroups: MessageGroup[] = [];

  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    const groupTokens = group.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

    if (tokenCount + groupTokens > tokenBudget && selectedGroups.length >= 2) break;

    tokenCount += groupTokens;
    selectedGroups.unshift(group);
  }

  const selected = selectedGroups.flatMap((g) => g.messages);
  if (selected.length === 0) return [];

  const selectedSet = new Set(selected.map((m) => m.id));

  const lastIdx = messages.length - 1;
  const lastUserIdx = messages.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);

  const forcedMsgIds = new Set<number>();
  if (!selectedSet.has(messages[lastIdx].id)) forcedMsgIds.add(lastIdx);
  if (lastUserIdx >= 0 && !selectedSet.has(messages[lastUserIdx].id)) forcedMsgIds.add(lastUserIdx);

  if (forcedMsgIds.size > 0) {
    const forcedGroupIdxes = new Set<number>();
    for (const msgIdx of forcedMsgIds) {
      for (let gi = 0; gi < groups.length; gi++) {
        if (groups[gi].messages.some((m) => m.id === messages[msgIdx].id)) {
          forcedGroupIdxes.add(gi);
          break;
        }
      }
    }
    for (const gi of forcedGroupIdxes) {
      for (const m of groups[gi].messages) {
        if (!selectedSet.has(m.id)) {
          selected.push(m);
          selectedSet.add(m.id);
        }
      }
    }
  }

  const idxMap = new Map(messages.map((m, i) => [m.id, i]));
  selected.sort((a, b) => (idxMap.get(a.id) ?? 0) - (idxMap.get(b.id) ?? 0));
  return selected;
}

type MessageGroup = { messages: Message[] };

function buildMessageGroups(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const toolCallToAssistantIdx = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const id of getToolCallIds(msg)) {
        toolCallToAssistantIdx.set(id, i);
      }
    }
  }

  const assigned = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    if (assigned.has(i)) continue;
    const msg = messages[i];

    if (msg.role === 'assistant' && msg.tool_calls) {
      const group: Message[] = [msg];
      assigned.add(i);
      for (let j = i + 1; j < messages.length; j++) {
        if (assigned.has(j)) continue;
        const candidate = messages[j];
        if (candidate.role === 'tool' && candidate.tool_call_id && getToolCallIds(msg).has(candidate.tool_call_id)) {
          group.push(candidate);
          assigned.add(j);
        }
      }
      groups.push({ messages: group });
    } else if (msg.role === 'tool' && msg.tool_call_id && toolCallToAssistantIdx.has(msg.tool_call_id)) {
      continue;
    } else {
      assigned.add(i);
      groups.push({ messages: [msg] });
    }
  }

  return groups;
}

export type Document = {
  id: number;
  user_id: number;
  filename: string;
  mime_type: string;
  size: number;
  r2_key: string;
  hash: string;
  description: string | null;
  created_at: string;
};

type CreateDocumentInput = {
  userId: number;
  filename: string;
  mimeType: string;
  size: number;
  r2Key: string;
  hash: string;
  description?: string;
};

export async function createDocument(db: D1Database, input: CreateDocumentInput): Promise<Document> {
  const result = await db
    .prepare('INSERT INTO documents (user_id, filename, mime_type, size, r2_key, hash, description) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(input.userId, input.filename, input.mimeType, input.size, input.r2Key, input.hash, input.description ?? null)
    .run();
  const id = result.meta.last_row_id as number;
  return db.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first<Document>()!;
}

export async function getDocument(db: D1Database, id: number): Promise<Document | null> {
  return db.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first<Document>();
}

export async function listDocuments(db: D1Database, userId: number): Promise<Document[]> {
  const result = await db
    .prepare('SELECT * FROM documents WHERE user_id = ? ORDER BY id DESC')
    .bind(userId)
    .all<Document>();
  return result.results;
}

export async function renameDocument(db: D1Database, id: number, filename: string): Promise<Document> {
  await db.prepare('UPDATE documents SET filename = ? WHERE id = ?').bind(filename, id).run();
  return db.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first<Document>()!;
}

export async function deleteDocument(db: D1Database, id: number): Promise<boolean> {
  const result = await db.batch([
    db.prepare('DELETE FROM chunks WHERE doc_id = ?').bind(id),
    db.prepare('DELETE FROM documents WHERE id = ?').bind(id),
  ]);
  return result[1].meta.changes > 0;
}

export async function getDocumentOwnerId(db: D1Database, id: number): Promise<number | null> {
  const row = await db.prepare('SELECT user_id FROM documents WHERE id = ?').bind(id).first<{ user_id: number }>();
  return row?.user_id ?? null;
}

export async function getChunk(db: D1Database, id: number): Promise<Chunk | null> {
  return db.prepare('SELECT * FROM chunks WHERE id = ?').bind(id).first<Chunk>();
}

export async function getChunkIdsByDoc(db: D1Database, docId: number): Promise<number[]> {
  const result = await db.prepare('SELECT id FROM chunks WHERE doc_id = ?').bind(docId).all<{ id: number }>();
  return result.results.map(r => r.id);
}

export type Chunk = {
  id: number;
  doc_id: number | null;
  seq: number;
  content: string;
  token_count: number;
  source: string;
  expires_at: string | null;
  created_at: string;
};

type InsertChunkInput = {
  docId: number;
  userId: number;
  seq: number;
  content: string;
  tokenCount: number;
};

export async function insertChunk(db: D1Database, input: InsertChunkInput): Promise<Chunk|null> {
  const tokenized = tokenizeCJK(input.content);
  const result = await db.batch([
    db.prepare('INSERT INTO chunks (doc_id, user_id, seq, content, token_count) VALUES (?, ?, ?, ?, ?)').bind(input.docId, input.userId, input.seq, input.content, input.tokenCount),
    db.prepare('INSERT INTO chunks_fts (rowid, content) VALUES (last_insert_rowid(), ?)').bind(tokenized),
  ]);
  const id = result[0].meta.last_row_id as number;
  return db.prepare('SELECT * FROM chunks WHERE id = ?').bind(id).first<Chunk>()!;
}

export type ChatMemoryInput = {
  userId: number;
  content: string;
  category: string;
};

export type UpdateChatMemoryInput = {
  content: string;
  category: string;
};

export function getExpiresAt(category: string): string | null {
  const fmt = (ms: number) => {
    const d = new Date(Date.now() + ms + 8 * 3600 * 1000);
    return d.toISOString().replace('T', ' ').replace('Z', '');
  };
  if (category === 'fact') return null;
  if (category === 'preference') return fmt(180 * 86400 * 1000);
  return fmt(7 * 86400 * 1000);
}

export async function insertChatMemory(db: D1Database, input: ChatMemoryInput): Promise<Chunk | null> {
  const expiresAt = getExpiresAt(input.category);
  const tokenized = tokenizeCJK(input.content);
  const tokenCount = estimateTokens(input.content);
  const result = await db.batch([
    db.prepare('INSERT INTO chunks (doc_id, user_id, seq, content, token_count, source, expires_at) VALUES (NULL, ?, 0, ?, ?, ?, ?)')
      .bind(input.userId, input.content, tokenCount, 'chat', expiresAt),
    db.prepare('INSERT INTO chunks_fts (rowid, content) VALUES (last_insert_rowid(), ?)').bind(tokenized),
  ]);
  const id = result[0].meta.last_row_id as number;
  return db.prepare('SELECT * FROM chunks WHERE id = ?').bind(id).first<Chunk>()!;
}

export async function updateChatMemory(db: D1Database, id: number, input: UpdateChatMemoryInput): Promise<boolean> {
  const expiresAt = getExpiresAt(input.category);
  const tokenized = tokenizeCJK(input.content);
  const result = await db.batch([
    db.prepare('UPDATE chunks SET content = ?, expires_at = ? WHERE id = ?')
      .bind(input.content, expiresAt, id),
    db.prepare('INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES(?, ?, ?)')
      .bind('delete', id, ''),
    db.prepare('INSERT INTO chunks_fts(rowid, content) VALUES(?, ?)')
      .bind(id, tokenized),
  ]);
  return result[0].meta.changes > 0;
}

type FTSResult = {
  id: number;
  content: string;
  score: number;
  doc_id: number;
};

export async function searchFTS(db: D1Database, query: string, limit: number | undefined, userId: number): Promise<FTSResult[]> {
  const tokenized = tokenizeCJK(query);
  const terms = tokenized.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const ftsQuery = terms.map((t) => `${t}*`).join(' AND ');
  const result = await db
    .prepare(
      `SELECT c.id, c.content, c.doc_id, bm25(chunks_fts) AS score FROM chunks_fts f JOIN chunks c ON f.rowid = c.id WHERE chunks_fts MATCH ? AND c.user_id = ? AND (c.source = 'document' OR (c.source = 'chat' AND (c.expires_at IS NULL OR c.expires_at > datetime('now', '+8 hours')))) ORDER BY score LIMIT ?`,
    )
    .bind(ftsQuery, userId, limit ?? 20)
    .all<FTSResult>();
  return result.results;
}
