import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QdrantDAO } from '../../../src/dao/qdrant';

const INDEX_OK = { ok: true, json: async () => ({ result: [] }) };

describe('Qdrant DAO', () => {
  let dao: QdrantDAO;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    dao = new QdrantDAO({ url: 'http://localhost:6333', apiKey: 'test-key' });
  });

  it('ensures collection exists (creates if 404)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce(INDEX_OK);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    await dao.ensureCollection();
    const createCall = fetchMock.mock.calls[1];
    expect(createCall[0]).toBe('http://localhost:6333/collections/chunks');
    expect(createCall[1].method).toBe('PUT');
    const body = JSON.parse(createCall[1].body);
    expect(body.vectors.size).toBe(1024);
    expect(body.vectors.distance).toBe('Cosine');
  });

  it('skips creation if collection exists', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: { status: 'green' } }) });
    fetchMock.mockResolvedValueOnce(INDEX_OK);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    await dao.ensureCollection();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:6333/collections/chunks');
  });

  it('upserts vectors with numeric point ID (Qdrant rejects string numerics)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: {} }) });
    fetchMock.mockResolvedValueOnce(INDEX_OK);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    await dao.upsertVectors([
      { id: 42, vector: [0.1, 0.2], payload: { chunk_id: 42, doc_id: 1, user_id: 1, seq: 0 } }
    ]);
    const upsertCall = fetchMock.mock.calls.find(c => c[0]?.includes('/points') && c[1]?.method === 'PUT' && !c[0]?.includes('/search'));
    const body = JSON.parse(upsertCall![1].body);
    expect(body.points[0].id).toBe(42);
  });

  it('upserts vectors with UUID string ID', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: {} }) });
    fetchMock.mockResolvedValueOnce(INDEX_OK);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    await dao.upsertVectors([
      { id: uuid, vector: [0.1], payload: { chunk_id: 1 } }
    ]);
    const upsertCall = fetchMock.mock.calls.find(c => c[0]?.includes('/points') && c[1]?.method === 'PUT' && !c[0]?.includes('/search'));
    const body = JSON.parse(upsertCall![1].body);
    expect(body.points[0].id).toBe(uuid);
  });

  it('searches by vector with user_id filter', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: {} }) });
    fetchMock.mockResolvedValueOnce(INDEX_OK);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: [{ id: '1', score: 0.95, payload: { chunk_id: 1 } }] })
    });
    const results = await dao.searchVectors([0.1, 0.2], 1, 5);
    expect(results.length).toBe(1);
    expect(results[0].score).toBe(0.95);
    const searchCall = fetchMock.mock.calls.find(c => c[0]?.includes('/points/search'));
    expect(searchCall![0]).toBe('http://localhost:6333/collections/chunks/points/search');
    expect(searchCall![1].method).toBe('POST');
    const body = JSON.parse(searchCall![1].body);
    expect(body.vector).toEqual([0.1, 0.2]);
    expect(body.filter.must[0]).toEqual({ key: 'user_id', match: { value: 1 } });
    expect(body.limit).toBe(5);
    expect(body.with_payload).toBe(true);
  });

  it('deletes vectors by chunk_ids as integers', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: {} }) });
    await dao.deleteByChunkIds([1, 2, 3]);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('http://localhost:6333/collections/chunks/points/delete');
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body);
    expect(body.points).toEqual([1, 2, 3]);
  });

  it('sends api-key header on every request', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: {} }) });
    fetchMock.mockResolvedValueOnce(INDEX_OK);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    await dao.upsertVectors([{ id: 1, vector: [0.1], payload: { chunk_id: 1, doc_id: 1, user_id: 1, seq: 0 } }]);
    const upsertCall = fetchMock.mock.calls.find(c => c[0]?.includes('/points') && c[1]?.method === 'PUT' && !c[0]?.includes('/search'));
    const headers = upsertCall![1].headers;
    expect(headers['api-key']).toBe('test-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('uses custom collection name when provided', async () => {
    const customDao = new QdrantDAO({ url: 'http://localhost:6333', apiKey: 'test-key', collection: 'xvc_agent_chunks' });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: { status: 'green' } }) });
    fetchMock.mockResolvedValueOnce(INDEX_OK);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    await customDao.ensureCollection();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:6333/collections/xvc_agent_chunks');
  });

  it('defaults collection name to "chunks" when not provided', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: { status: 'green' } }) });
    fetchMock.mockResolvedValueOnce(INDEX_OK);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    await dao.ensureCollection();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:6333/collections/chunks');
  });

  it('searchVectors includes source/expiration filter', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: {} }) });
    fetchMock.mockResolvedValueOnce(INDEX_OK);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: [{ id: 1, score: 0.9, payload: { chunk_id: 1, source: 'chat' } }] }),
    });
    await dao.searchVectors([0.1], 1, 5);
    const searchCall = fetchMock.mock.calls.find(c => c[0]?.includes('/points/search'));
    const body = JSON.parse(searchCall![1].body);
    const shouldClause = body.filter.must.find((c: any) => 'should' in c);
    expect(shouldClause).toBeDefined();
    expect(shouldClause.should.length).toBeGreaterThanOrEqual(2);
  });

  it('searchVectors throws on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: {} }) });
    fetchMock.mockResolvedValueOnce(INDEX_OK);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ status: { error: 'Not found' } }),
    });
    await expect(dao.searchVectors([0.1], 1, 5)).rejects.toThrow(/Qdrant search failed.*404/);
  });

  it('upsertVectors throws on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: {} }) });
    fetchMock.mockResolvedValueOnce(INDEX_OK);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: true }) });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ status: { error: 'Internal' } }),
    });
    await expect(dao.upsertVectors([{ id: 1, vector: [0.1], payload: {} }]))
      .rejects.toThrow(/Qdrant upsert failed.*500/);
  });
});
