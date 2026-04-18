type OutboxEvent = {
  id: number;
  event_type: string;
  chunk_id: number;
  payload: string | null;
  status: string;
  attempts: number;
  created_at: string;
  updated_at: string;
};

type CreateEventInput = {
  eventType: string;
  chunkId: number;
  payload?: string;
};

export async function createEvent(db: D1Database, input: CreateEventInput): Promise<OutboxEvent> {
  const result = await db
    .prepare('INSERT INTO outbox_events (event_type, chunk_id, payload) VALUES (?, ?, ?)')
    .bind(input.eventType, input.chunkId, input.payload ?? null)
    .run();
  const id = result.meta.last_row_id as number;
  return db.prepare('SELECT * FROM outbox_events WHERE id = ?').bind(id).first<OutboxEvent>()!;
}

export async function markCompleted(db: D1Database, id: number): Promise<OutboxEvent> {
  await db
    .prepare("UPDATE outbox_events SET status = 'completed', updated_at = datetime('now', '+8 hours') WHERE id = ?")
    .bind(id)
    .run();
  return db.prepare('SELECT * FROM outbox_events WHERE id = ?').bind(id).first<OutboxEvent>()!;
}

export async function markFailed(db: D1Database, id: number): Promise<OutboxEvent> {
  await db
    .prepare(
      "UPDATE outbox_events SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END, updated_at = datetime('now', '+8 hours') WHERE id = ?",
    )
    .bind(id)
    .run();
  return db.prepare('SELECT * FROM outbox_events WHERE id = ?').bind(id).first<OutboxEvent>()!;
}

export async function getPendingEvents(db: D1Database): Promise<OutboxEvent[]> {
  const result = await db
    .prepare(
      "SELECT * FROM outbox_events WHERE status = 'pending' AND updated_at < datetime('now', '+8 hours', '-30 seconds') ORDER BY created_at ASC",
    )
    .all<OutboxEvent>();
  return result.results;
}

export async function claimEvent(db: D1Database, id: number): Promise<boolean> {
  const result = await db
    .prepare("UPDATE outbox_events SET status = 'processing', updated_at = datetime('now', '+8 hours') WHERE id = ? AND status = 'pending'")
    .bind(id)
    .run();
  return result.meta.changes > 0;
}
