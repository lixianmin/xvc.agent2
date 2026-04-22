import { Hono } from 'hono';
import { serveStatic } from 'hono/cloudflare-workers';
import { createUser, getUser, updateUser, createThread, listThreads, deleteThread, updateThreadTitle, saveMessage, loadMessages, createTask, listTasks, updateTask, deleteTask, getTaskOwnerId, createDocument, getDocument, listDocuments, deleteDocument, renameDocument, getDocumentOwnerId, getThreadOwnerId, getChunk, getChunkIdsByDoc } from './dao/d1';
import { createEvent, markCompleted, markFailed, getPendingEvents, claimEvent, countByStatus } from './dao/outbox';
import { LLMClient } from './llm/client';
import { EmbeddingClient } from './llm/embedding';
import { QdrantDAO } from './dao/qdrant';
import { AgentLoop } from './agent/loop';
import { authMiddleware } from './middleware/auth';
import { createOwnershipCheck, createBodyOwnershipCheck } from './middleware/ownership';
import { processFileUpload } from './services/upload';
import { config } from './config';
import { log } from './services/logger';

type Bindings = {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  GLM_API_KEY: string;
  SILICONFLOW_API_KEY: string;
  QDRANT_URL: string;
  QDRANT_API_KEY: string;
  QDRANT_COLLECTION: string;
  SERPER_API_KEY: string;
};

type Variables = {
  user: { id: number; email: string; name: string; ai_nickname: string | null };
};

type Env = { Bindings: Bindings; Variables: Variables };

const app = new Hono<Env>();

app.use('*', async (c, next) => {
  await next();
  if (c.res.headers.get('Content-Type')?.startsWith('text/html')) {
    c.res.headers.set('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'");
  }
});

function parseId(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

const ownThreadByQuery = createOwnershipCheck(
  (c) => parseId(c.req.query('id')),
  getThreadOwnerId,
);

const ownThreadByBody = createBodyOwnershipCheck<{ id: number }>(
  (body) => body.id ?? null,
  getThreadOwnerId,
);

const ownTaskByBody = createBodyOwnershipCheck<{ id: number }>(
  (body) => body.id ?? null,
  getTaskOwnerId,
);

const ownDocumentByBody = createBodyOwnershipCheck<{ id: number }>(
  (body) => body.id ?? null,
  getDocumentOwnerId,
);

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
  const id = parseId(c.req.query('id'));
  if (id === null) return c.json({ error: 'Invalid id' }, 400);
  const user = await getUser(c.env.DB, id);
  if (!user) return c.json({ error: 'User not found' }, 404);
  return c.json(user);
});

app.post('/api/user/update', authMiddleware, async (c) => {
  const { id, ...fields } = await c.req.json();
  const user = c.get('user');
  if (id !== user.id) return c.json({ error: 'Forbidden' }, 403);
  const updated = await updateUser(c.env.DB, id, fields);
  return c.json(updated);
});

app.get('/api/threads/list', authMiddleware, async (c) => {
  const userId = parseId(c.req.query('userId'));
  if (userId === null) return c.json({ error: 'Invalid userId' }, 400);
  const threads = await listThreads(c.env.DB, userId);
  return c.json(threads);
});

app.post('/api/threads/create', authMiddleware, async (c) => {
  const { userId, title } = await c.req.json();
  const thread = await createThread(c.env.DB, { userId, title });
  log.info('index:threads/create', 'thread created', { id: thread.id, userId });
  return c.json(thread);
});

app.get('/api/threads/messages', authMiddleware, ownThreadByQuery, async (c) => {
  const id = parseId(c.req.query('id'));
  const msgs = await loadMessages(c.env.DB, id!);
  return c.json(msgs);
});

app.post('/api/threads/delete', authMiddleware, ownThreadByBody, async (c) => {
  const { id } = c.get('parsedBody') as { id: number };
  log.info('index:threads/delete', 'deleting thread', { id });
  await deleteThread(c.env.DB, id);
  return c.json({ ok: true });
});

app.post('/api/threads/update-title', authMiddleware, ownThreadByBody, async (c) => {
  const { id, title } = c.get('parsedBody') as { id: number; title: string };
  await updateThreadTitle(c.env.DB, id, title);
  return c.json({ ok: true });
});

app.post('/api/chat', authMiddleware, async (c) => {
  const { threadId: threadIdRaw, message, content: rawContent } = await c.req.json();
  const content = message ?? rawContent;
  const threadId = parseId(threadIdRaw);
  if (threadId === null) return c.json({ error: 'Invalid threadId' }, 400);
  if (!content) return c.json({ error: 'Missing message' }, 400);
  const user = c.get('user');

  log.info('index:chat', 'chat request', { threadId, userId: user.id, contentLen: content.length, hasGLMKey: !!c.env.GLM_API_KEY });

  const deps = {
    d1: c.env.DB,
    llm: new LLMClient({ apiKey: c.env.GLM_API_KEY, baseUrl: config.llm.baseUrl, model: config.llm.model }),
    embedding: new EmbeddingClient({ apiKey: c.env.SILICONFLOW_API_KEY, baseUrl: config.embedding.baseUrl, model: config.embedding.model }),    qdrant: new QdrantDAO({ url: c.env.QDRANT_URL, apiKey: c.env.QDRANT_API_KEY, collection: c.env.QDRANT_COLLECTION }),
    serperApiKey: c.env.SERPER_API_KEY,
    files: c.env.FILES,
  };

  const loop = new AgentLoop(deps);
  const stream = loop.run(user.id, threadId, content);
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
});

app.get('/api/tasks/list', authMiddleware, async (c) => {
  const userId = parseId(c.req.query('userId'));
  if (userId === null) return c.json({ error: 'Invalid userId' }, 400);
  const status = c.req.query('status') ?? undefined;
  const tasks = await listTasks(c.env.DB, userId, status);
  return c.json(tasks);
});

app.post('/api/tasks/create', authMiddleware, async (c) => {
  const { userId, title, description, priority } = await c.req.json();
  const task = await createTask(c.env.DB, { userId, title, description, priority });
  return c.json(task);
});

app.post('/api/tasks/update', authMiddleware, ownTaskByBody, async (c) => {
  const { id, ...fields } = c.get('parsedBody') as { id: number; [key: string]: unknown };
  const task = await updateTask(c.env.DB, id, fields);
  return c.json(task);
});

app.post('/api/tasks/delete', authMiddleware, ownTaskByBody, async (c) => {
  const { id } = c.get('parsedBody') as { id: number };
  await deleteTask(c.env.DB, id);
  return c.json({ ok: true });
});

app.post('/api/files/upload', authMiddleware, async (c) => {
  const user = c.get('user');
  const formData = await c.req.formData();
  const file = formData.get('file');

  if (!file || !(file instanceof File)) {
    return c.json({ error: 'No file provided' }, 400);
  }

  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (!config.upload.allowedExtensions.includes(ext)) {
    return c.json({ error: `Unsupported file type: .${ext}` }, 400);
  }

  if (file.size > config.upload.maxFileSize) {
    return c.json({ error: `File too large: ${file.size} bytes (max ${config.upload.maxFileSize})` }, 400);
  }

  const isImage = file.type.startsWith('image/');
  if (isImage && file.size > config.upload.maxImageSize) {
    return c.json({ error: `Image too large: ${file.size} bytes (max ${config.upload.maxImageSize})` }, 400);
  }

  const visionClient = isImage ? new LLMClient({
    apiKey: c.env.GLM_API_KEY,
    baseUrl: config.vision.baseUrl,
    model: config.vision.model,
  }) : undefined;

  let doc;
  try {
    doc = await processFileUpload({
      r2: c.env.FILES,
      d1: c.env.DB,
      qdrant: new QdrantDAO({ url: c.env.QDRANT_URL, apiKey: c.env.QDRANT_API_KEY, collection: c.env.QDRANT_COLLECTION }),
      embedding: new EmbeddingClient({ apiKey: c.env.SILICONFLOW_API_KEY, baseUrl: config.embedding.baseUrl, model: config.embedding.model }),
      userId: user.id,
      visionClient,
    }, file);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (msg.includes('Too many subrequests') || msg.includes('subrequest')) {
      return c.json({ error: '云端服务请求数已达上限（免费账户限制）。建议上传较小的文件或稍后重试，升级 Cloudflare 付费账户可解除此限制。' }, 429);
    }
    throw err;
  }

  return c.json(doc);
});

app.get('/api/files/list', authMiddleware, async (c) => {
  const userId = parseId(c.req.query('userId'));
  if (userId === null) return c.json({ error: 'Invalid userId' }, 400);
  const docs = await listDocuments(c.env.DB, userId);
  return c.json(docs);
});

app.get('/api/files/download', authMiddleware, async (c) => {
  const id = parseId(c.req.query('id'));
  if (id === null) return c.json({ error: 'Invalid id' }, 400);
  const doc = await getDocument(c.env.DB, id);
  if (!doc) return c.json({ error: 'Document not found' }, 404);
  const user = c.get('user');
  if (doc.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);
  const obj = await c.env.FILES.get(doc.r2_key);
  if (!obj) return c.json({ error: 'File not found in storage' }, 404);
      const safeName = doc.filename.replace(/["\r\n]/g, '_');
      return new Response(obj.body, {
        headers: {
          'Content-Type': doc.mime_type,
          'Content-Disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      'Content-Length': String(doc.size),
    },
  });
});

app.post('/api/files/delete', authMiddleware, ownDocumentByBody, async (c) => {
  const { id } = c.get('parsedBody') as { id: number };
  const doc = await getDocument(c.env.DB, id);
  const chunkIds = await getChunkIdsByDoc(c.env.DB, id);
  await deleteDocument(c.env.DB, id);
  if (chunkIds.length > 0) {
    const qdrant = new QdrantDAO({ url: c.env.QDRANT_URL, apiKey: c.env.QDRANT_API_KEY, collection: c.env.QDRANT_COLLECTION });
    await qdrant.deleteByChunkIds(chunkIds);
  }
  if (doc?.r2_key) {
    await c.env.FILES.delete(doc.r2_key);
  }
  return c.json({ ok: true });
});

app.post('/api/files/rename', authMiddleware, ownDocumentByBody, async (c) => {
  const { id, filename } = c.get('parsedBody') as { id: number; filename: string };
  if (!filename || typeof filename !== 'string') return c.json({ error: 'Invalid filename' }, 400);
  const doc = await renameDocument(c.env.DB, id, filename);
  return c.json(doc);
});

app.post('/api/admin/process-outbox', authMiddleware, async (c) => {
  const events = await getPendingEvents(c.env.DB);
  let processed = 0;

  for (const event of events) {
    const claimed = await claimEvent(c.env.DB, event.id);
    if (!claimed) continue;

    try {
      if (event.event_type === 'embed_chunk') {
        const payload = event.payload ? JSON.parse(event.payload) : {};
        const chunk = await getChunk(c.env.DB, event.chunk_id);
        if (chunk) {
          const embedding = new EmbeddingClient({ apiKey: c.env.SILICONFLOW_API_KEY, baseUrl: config.embedding.baseUrl, model: config.embedding.model });
          const qdrant = new QdrantDAO({ url: c.env.QDRANT_URL, apiKey: c.env.QDRANT_API_KEY, collection: c.env.QDRANT_COLLECTION });
          const [vector] = await embedding.embed([chunk.content]);
          await qdrant.upsertVectors([{
            id: chunk.id,
            vector,
            payload: { chunk_id: chunk.id, doc_id: chunk.doc_id, user_id: payload.userId, source: 'document', seq: chunk.seq, content: chunk.content },
          }]);
        }
      } else if (event.event_type === 'delete_vector') {
        const qdrant = new QdrantDAO({ url: c.env.QDRANT_URL, apiKey: c.env.QDRANT_API_KEY, collection: c.env.QDRANT_COLLECTION });
        await qdrant.deleteByChunkIds([event.chunk_id]);
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
  return c.json({
    pending: await countByStatus(db, 'pending'),
    processing: await countByStatus(db, 'processing'),
    failed: await countByStatus(db, 'failed'),
    completed: await countByStatus(db, 'completed'),
  });
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    const events = await getPendingEvents(env.DB);
    let processed = 0;

    for (const event of events) {
      const claimed = await claimEvent(env.DB, event.id);
      if (!claimed) continue;

      try {
        if (event.event_type === 'embed_chunk') {
          const payload = event.payload ? JSON.parse(event.payload) : {};
          const chunk = await getChunk(env.DB, event.chunk_id);
          if (chunk) {
            const embedding = new EmbeddingClient({ apiKey: env.SILICONFLOW_API_KEY, baseUrl: config.embedding.baseUrl, model: config.embedding.model });
            const qdrant = new QdrantDAO({ url: env.QDRANT_URL, apiKey: env.QDRANT_API_KEY, collection: env.QDRANT_COLLECTION });
            const [vector] = await embedding.embed([chunk.content]);
            await qdrant.upsertVectors([{
              id: chunk.id,
              vector,
              payload: { chunk_id: chunk.id, doc_id: chunk.doc_id, user_id: payload.userId, source: 'document', seq: chunk.seq, content: chunk.content },
            }]);
          }
        } else if (event.event_type === 'delete_vector') {
          const qdrant = new QdrantDAO({ url: env.QDRANT_URL, apiKey: env.QDRANT_API_KEY, collection: env.QDRANT_COLLECTION });
          await qdrant.deleteByChunkIds([event.chunk_id]);
        }
        await markCompleted(env.DB, event.id);
        processed++;
      } catch {
        await markFailed(env.DB, event.id);
      }
    }

    log.info('index:scheduled', 'outbox processed', { processed });
  },
};

export { app };
