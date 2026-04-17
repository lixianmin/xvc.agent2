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

export async function listTasks(db: D1Database, userId: number): Promise<Task[]> {
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

type Conversation = {
  id: number;
  user_id: number;
  title: string | null;
  created_at: string;
  updated_at: string;
};

type CreateConversationInput = {
  userId: number;
  title?: string;
};

export async function createConversation(db: D1Database, input: CreateConversationInput): Promise<Conversation> {
  const result = await db
    .prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?)')
    .bind(input.userId, input.title ?? null)
    .run();
  const id = result.meta.last_row_id as number;
  return db.prepare('SELECT * FROM conversations WHERE id = ?').bind(id).first<Conversation>()!;
}

export async function getConversation(db: D1Database, id: number): Promise<Conversation | null> {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').bind(id).first<Conversation>();
}

export async function listConversations(db: D1Database, userId: number): Promise<Conversation[]> {
  const result = await db
    .prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY id DESC')
    .bind(userId)
    .all<Conversation>();
  return result.results;
}

export async function deleteConversation(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM conversations WHERE id = ?').bind(id).run();
  return result.meta.changes > 0;
}

type Message = {
  id: number;
  conversation_id: number;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  created_at: string;
};

type SaveMessageInput = {
  conversation_id: number;
  role: string;
  content: string;
  tool_calls?: string;
  tool_call_id?: string;
};

export async function saveMessage(db: D1Database, input: SaveMessageInput): Promise<Message> {
  const result = await db
    .prepare('INSERT INTO messages (conversation_id, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?)')
    .bind(input.conversation_id, input.role, input.content, input.tool_calls ?? null, input.tool_call_id ?? null)
    .run();
  const id = result.meta.last_row_id as number;
  return db.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first<Message>()!;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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

export async function loadMessages(db: D1Database, conversationId: number, tokenBudget = 8000): Promise<Message[]> {
  const result = await db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .bind(conversationId)
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

  const lastIdx = messages.length - 1;
  const lastUserIdx = messages.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);

  const selectedSet = new Set(selected.map((m) => m.id));
  if (!selectedSet.has(messages[lastIdx].id)) {
    selected.push(messages[lastIdx]);
  }
  if (lastUserIdx >= 0 && !selectedSet.has(messages[lastUserIdx].id)) {
    selected.push(messages[lastUserIdx]);
  }

  selected.sort((a, b) => messages.indexOf(a) - messages.indexOf(b));
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
