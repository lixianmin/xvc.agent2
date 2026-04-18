import { parseFile } from './parser';
import { cleanText } from './cleaner';
import { chunkText } from './chunker';
import { createDocument, insertChunk } from '../dao/d1';
import type { Document } from '../dao/d1';
import { createEvent, markCompleted } from '../dao/outbox';
import type { QdrantDAO } from '../dao/qdrant';
import type { EmbeddingClient } from '../llm/embedding';

export async function processFileUpload(
  deps: {
    r2: R2Bucket;
    d1: D1Database;
    qdrant: QdrantDAO;
    embedding: EmbeddingClient;
    userId: number;
  },
  file: File,
): Promise<Document> {
  const buffer = await file.arrayBuffer();
  const r2Key = `user/${deps.userId}/${Date.now()}_${file.name}`;

  await deps.r2.put(r2Key, buffer);

  const hash = await computeHash(buffer);

  const doc = await createDocument(deps.d1, {
    userId: deps.userId,
    filename: file.name,
    mimeType: file.type,
    size: buffer.byteLength,
    r2Key,
    hash,
  });

  const rawText = await parseFile(buffer, file.type, file.name);
  const text = cleanText(rawText);
  const chunks = chunkText(text);

  for (const chunk of chunks) {
    const saved = await insertChunk(deps.d1, {
      docId: doc!.id,
      userId: deps.userId,
      seq: chunk.seq,
      content: chunk.content,
      tokenCount: chunk.tokenCount,
    });

    const event = await createEvent(deps.d1, {
      eventType: 'embed_chunk',
      chunkId: saved.id,
      payload: JSON.stringify({ docId: doc.id, userId: deps.userId }),
    });

    try {
      const [vector] = await deps.embedding.embed([chunk.content]);
      await deps.qdrant.upsertVectors([{
        id: String(saved.id),
        vector,
        payload: { chunk_id: saved.id, doc_id: doc.id, user_id: deps.userId, source: 'document', seq: chunk.seq },
      }]);
      await markCompleted(deps.d1, event.id);
    } catch (err) {
      console.error('[upload] embed/qdrant failed, outbox will retry:', err);
    }
  }

  return doc;
}

async function computeHash(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
