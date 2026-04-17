import { Hono } from 'hono';
import { serveStatic } from 'hono/cloudflare-workers';
import { createUser, getUser, updateUser, createThread, listThreads, deleteThread, saveMessage, loadMessages, createTask, listTasks, updateTask, deleteTask, createDocument, listDocuments, deleteDocument } from './dao/d1';
import { createEvent, markCompleted, markFailed, getPendingEvents } from './dao/outbox';
import { LLMClient } from './llm/client';
import { EmbeddingClient } from './llm/embedding';
import { QdrantDAO } from './dao/qdrant';
import { AgentLoop } from './agent/loop';
import { authMiddleware } from './middleware/auth';
import { processFileUpload } from './services/upload';
import { log } from './services/logger';

type Bindings = {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  GLM_API_KEY: string;
  SILICONFLOW_API_KEY: string;
  QDRANT_URL: string;
  QDRANT_API_KEY: string;
  SERPER_API_KEY: string;
};

type Variables = {
  user: { id: number; email: string; name: string; ai_nickname: string | null };
};

type Env = { Bindings: Bindings; Variables: Variables };

const app = new Hono<Env>();

app.get('/api/health', (c) => {
  log.info('index:health', 'health check');
  return c.json({ status: 'ok', env: { hasGLMKey: !!c.env.GLM_API_KEY, hasSiliconKey: !!c.env.SILICONFLOW_API_KEY, hasQdrantUrl: !!c.env.QDRANT_URL } });
});

app.post('/api/user/create', async (c) => {
  const { email, name } = await c.req.json();
  const user = await createUser(c.env.DB, { email, name });
  return c.json(user);
});

app.get('/api/user', authMiddleware, async (c) => {
  const id = parseInt(c.req.query('id') ?? '');
  const user = await getUser(c.env.DB, id);
  if (!user) return c.json({ error: 'User not found' }, 404);
  return c.json(user);
});

app.post('/api/user/update', authMiddleware, async (c) => {
  const { id, ...fields } = await c.req.json();
  const user = await updateUser(c.env.DB, id, fields);
  return c.json(user);
});

app.get('/api/threads/list', authMiddleware, async (c) => {
  const userId = parseInt(c.req.query('userId') ?? '');
  const threads = await listThreads(c.env.DB, userId);
  return c.json(threads);
});

app.post('/api/threads/create', authMiddleware, async (c) => {
  const { userId, title } = await c.req.json();
  const thread = await createThread(c.env.DB, { userId, title });
  return c.json(thread);
});

app.get('/api/threads/messages', authMiddleware, async (c) => {
  const id = parseInt(c.req.query('id') ?? '');
  const msgs = await loadMessages(c.env.DB, id);
  return c.json(msgs);
});

app.post('/api/threads/delete', authMiddleware, async (c) => {
  const { id } = await c.req.json();
  await deleteThread(c.env.DB, id);
  return c.json({ ok: true });
});

app.post('/api/chat', authMiddleware, async (c) => {
  const { threadId: threadIdRaw, content } = await c.req.json();
  const threadId = parseInt(threadIdRaw);
  const user = c.get('user');

  log.info('index:chat', 'chat request', { threadId, userId: user.id, contentLen: content.length, hasGLMKey: !!c.env.GLM_API_KEY });

  const deps = {
    d1: c.env.DB,
    llm: new LLMClient({ apiKey: c.env.GLM_API_KEY, baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'GLM-5' }),
    embedding: new EmbeddingClient({ apiKey: c.env.SILICONFLOW_API_KEY, baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3' }),
    qdrant: new QdrantDAO({ url: c.env.QDRANT_URL, apiKey: c.env.QDRANT_API_KEY }),
    serperApiKey: c.env.SERPER_API_KEY,
  };

  const loop = new AgentLoop(deps);
  const stream = loop.run(user.id, threadId, content);
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
});

app.get('/api/tasks/list', authMiddleware, async (c) => {
  const userId = parseInt(c.req.query('userId') ?? '');
  const tasks = await listTasks(c.env.DB, userId);
  return c.json(tasks);
});

app.post('/api/tasks/create', authMiddleware, async (c) => {
  const { userId, title, description, priority } = await c.req.json();
  const task = await createTask(c.env.DB, { userId, title, description, priority });
  return c.json(task);
});

app.post('/api/tasks/update', authMiddleware, async (c) => {
  const { id, ...fields } = await c.req.json();
  const task = await updateTask(c.env.DB, id, fields);
  return c.json(task);
});

app.post('/api/tasks/delete', authMiddleware, async (c) => {
  const { id } = await c.req.json();
  await deleteTask(c.env.DB, id);
  return c.json({ ok: true });
});

app.post('/api/files/upload', authMiddleware, async (c) => {
  const user = c.get('user');
  const formData = await c.req.formData();
  const file = formData.get('file') as File;

  const doc = await processFileUpload({
    r2: c.env.FILES,
    d1: c.env.DB,
    qdrant: new QdrantDAO({ url: c.env.QDRANT_URL, apiKey: c.env.QDRANT_API_KEY }),
    embedding: new EmbeddingClient({ apiKey: c.env.SILICONFLOW_API_KEY, baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3' }),
    userId: user.id,
  }, file);

  return c.json(doc);
});

app.get('/api/files/list', authMiddleware, async (c) => {
  const userId = parseInt(c.req.query('userId') ?? '');
  const docs = await listDocuments(c.env.DB, userId);
  return c.json(docs);
});

app.post('/api/files/delete', authMiddleware, async (c) => {
  const { id } = await c.req.json();
  const user = c.get('user');
  await deleteDocument(c.env.DB, id);
  return c.json({ ok: true });
});

app.post('/api/admin/process-outbox', authMiddleware, async (c) => {
  const events = await getPendingEvents(c.env.DB);
  let processed = 0;

  for (const event of events) {
    try {
      if (event.event_type === 'embed_chunk') {
        const payload = event.payload ? JSON.parse(event.payload) : {};
        const chunk = await c.env.DB.prepare('SELECT * FROM chunks WHERE id = ?').bind(event.chunk_id).first<any>();
        if (chunk) {
          const embedding = new EmbeddingClient({ apiKey: c.env.SILICONFLOW_API_KEY, baseUrl: 'https://api.siliconflow.cn', model: 'BAAI/bge-m3' });
          const qdrant = new QdrantDAO({ url: c.env.QDRANT_URL, apiKey: c.env.QDRANT_API_KEY });
          const [vector] = await embedding.embed([chunk.content]);
          await qdrant.upsertVectors([{
            id: String(chunk.id),
            vector,
            payload: { chunk_id: chunk.id, doc_id: chunk.doc_id, user_id: payload.userId },
          }]);
        }
      }
      await markCompleted(c.env.DB, event.id);
      processed++;
    } catch {
      await markFailed(c.env.DB, event.id);
    }
  }

  return c.json({ processed });
});

app.get('/api/admin/outbox-status', authMiddleware, async (c) => {
  const db = c.env.DB;
  const count = async (status: string) => {
    const r = await db.prepare('SELECT COUNT(*) as cnt FROM outbox_events WHERE status = ?').bind(status).first<{ cnt: number }>();
    return r?.cnt ?? 0;
  };
  return c.json({
    pending: await count('pending'),
    processing: await count('processing'),
    failed: await count('failed'),
    completed: await count('completed'),
  });
});

export default app;
