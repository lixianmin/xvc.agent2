import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QdrantDAO } from '../../../src/dao/qdrant';

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
    await dao.ensureCollection();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const createCall = fetchMock.mock.calls[1];
    expect(createCall[0]).toBe('http://localhost:6333/collections/chunks');
    expect(createCall[1].method).toBe('PUT');
    const body = JSON.parse(createCall[1].body);
    expect(body.vectors.size).toBe(1024);
    expect(body.vectors.distance).toBe('Cosine');
  });

  it('skips creation if collection exists', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: { status: 'green' } }) });
    await dao.ensureCollection();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:6333/collections/chunks');
  });

  it('upserts vectors with payload', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: {} }) });
    await dao.upsertVectors([
      { id: '1', vector: [0.1, 0.2], payload: { chunk_id: 1, doc_id: 1, user_id: 1, seq: 0 } }
    ]);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('http://localhost:6333/collections/chunks/points');
    expect(call[1].method).toBe('PUT');
    const body = JSON.parse(call[1].body);
    expect(body.points).toHaveLength(1);
    expect(body.points[0].id).toBe('1');
    expect(body.points[0].vector).toEqual([0.1, 0.2]);
    expect(body.points[0].payload).toEqual({ chunk_id: 1, doc_id: 1, user_id: 1, seq: 0 });
  });

  it('searches by vector with user_id filter', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: [{ id: '1', score: 0.95, payload: { chunk_id: 1 } }] })
    });
    const results = await dao.searchVectors([0.1, 0.2], 1, 5);
    expect(results.length).toBe(1);
    expect(results[0].score).toBe(0.95);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('http://localhost:6333/collections/chunks/points/search');
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body);
    expect(body.vector).toEqual([0.1, 0.2]);
    expect(body.filter.must[0]).toEqual({ key: 'user_id', match: { value: 1 } });
    expect(body.limit).toBe(5);
    expect(body.with_payload).toBe(true);
  });

  it('deletes vectors by chunk_ids', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: {} }) });
    await dao.deleteByChunkIds([1, 2, 3]);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('http://localhost:6333/collections/chunks/points/delete');
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body);
    expect(body.filter.should).toHaveLength(3);
    expect(body.filter.should[0]).toEqual({ key: 'chunk_id', match: { value: 1 } });
  });

  it('sends api-key header on every request', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: {} }) });
    await dao.upsertVectors([{ id: '1', vector: [0.1], payload: { chunk_id: 1, doc_id: 1, user_id: 1, seq: 0 } }]);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['api-key']).toBe('test-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('uses custom collection name when provided', async () => {
    const customDao = new QdrantDAO({ url: 'http://localhost:6333', apiKey: 'test-key', collection: 'xvc_agent_chunks' });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: { status: 'green' } }) });
    await customDao.ensureCollection();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:6333/collections/xvc_agent_chunks');
  });

  it('defaults collection name to "chunks" when not provided', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: { status: 'green' } }) });
    await dao.ensureCollection();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:6333/collections/chunks');
  });

  it('searchVectors throws on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ status: { error: 'Not found' } }),
    });
    await expect(dao.searchVectors([0.1], 1, 5)).rejects.toThrow(/Qdrant search failed.*404/);
  });

  it('upsertVectors throws on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ status: { error: 'Internal' } }),
    });
    await expect(dao.upsertVectors([{ id: '1', vector: [0.1], payload: {} }]))
      .rejects.toThrow(/Qdrant upsert failed.*500/);
  });
});
