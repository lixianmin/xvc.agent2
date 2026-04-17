import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createEvent,
  markCompleted,
  markFailed,
  getPendingEvents,
} from '../../../src/dao/outbox';

describe('Outbox management', () => {
  let db: D1Database;

  beforeAll(async () => {
    db = env.DB;
    await db.exec(
      "CREATE TABLE IF NOT EXISTS outbox_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL CHECK (event_type IN ('embed_chunk', 'delete_vector')), chunk_id INTEGER NOT NULL, payload TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')), attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')), updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')));",
    );
    await db.exec(
      "CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_events(status, created_at);",
    );
  });

  it('creates a pending event', async () => {
    const event = await createEvent(db, {
      eventType: 'embed_chunk',
      chunkId: 1,
      payload: '{"content":"test"}',
    });
    expect(event.id).toBeDefined();
    expect(event.status).toBe('pending');
    expect(event.event_type).toBe('embed_chunk');
    expect(event.chunk_id).toBe(1);
    expect(event.payload).toBe('{"content":"test"}');
    expect(event.attempts).toBe(0);
  });

  it('marks event as completed', async () => {
    const event = await createEvent(db, {
      eventType: 'embed_chunk',
      chunkId: 2,
      payload: '{}',
    });
    const updated = await markCompleted(db, event.id);
    expect(updated.status).toBe('completed');
  });

  it('increments attempts and marks failed after 3', async () => {
    const event = await createEvent(db, {
      eventType: 'embed_chunk',
      chunkId: 3,
      payload: '{}',
    });
    const after1 = await markFailed(db, event.id);
    expect(after1.status).toBe('pending');
    expect(after1.attempts).toBe(1);

    const after2 = await markFailed(db, event.id);
    expect(after2.status).toBe('pending');
    expect(after2.attempts).toBe(2);

    const after3 = await markFailed(db, event.id);
    expect(after3.status).toBe('failed');
    expect(after3.attempts).toBe(3);
  });

  it('gets pending events older than 30 seconds', async () => {
    const event = await createEvent(db, {
      eventType: 'embed_chunk',
      chunkId: 4,
      payload: '{}',
    });
    await db
      .prepare("UPDATE outbox_events SET updated_at = datetime('now', '+8 hours', '-60 seconds') WHERE id = ?")
      .bind(event.id)
      .run();
    const events = await getPendingEvents(db);
    expect(Array.isArray(events)).toBe(true);
    const found = events.find((e) => e.id === event.id);
    expect(found).toBeDefined();
  });

  it('returns empty array when no pending events', async () => {
    await db.exec("DELETE FROM outbox_events WHERE status = 'pending';");
    const events = await getPendingEvents(db);
    expect(events).toEqual([]);
  });
});
