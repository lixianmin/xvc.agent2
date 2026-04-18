import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getToolDefinitions, getSubAgentToolDefinitions, dispatchTool } from '../../../src/agent/tools';
import { createTask, listTasks, updateTask, deleteTask, listDocuments, deleteDocument, getChunkIdsByDoc, insertChatMemory, updateChatMemory } from '../../../src/dao/d1';
import { serperSearch, fetchUrl } from '../../../src/services/web';
import { chunksSearch } from '../../../src/services/search';

vi.mock('../../../src/dao/d1', () => ({
  createTask: vi.fn(),
  listTasks: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  listDocuments: vi.fn(),
  deleteDocument: vi.fn(),
  getChunkIdsByDoc: vi.fn().mockResolvedValue([]),
  insertChatMemory: vi.fn(),
  updateChatMemory: vi.fn(),
}));

vi.mock('../../../src/services/web', () => ({
  serperSearch: vi.fn(),
  fetchUrl: vi.fn(),
}));

vi.mock('../../../src/services/search', () => ({
  chunksSearch: vi.fn(),
}));

const mockD1 = {} as D1Database;
const mockQdrant = {
  deleteByChunkIds: vi.fn(),
  searchVectors: vi.fn(),
  upsertVectors: vi.fn(),
} as any;
const mockEmbedding = {
  embed: vi.fn(),
} as any;

function makeDeps() {
  return {
    d1: mockD1,
    userId: 42,
    qdrant: mockQdrant,
    embedding: mockEmbedding,
    serperApiKey: 'test-key',
  };
}

describe('getToolDefinitions', () => {
  it('returns 9 tools with correct names', () => {
    const defs = getToolDefinitions();
    expect(defs).toHaveLength(11);

    const names = defs.map((d) => d.function.name);
    expect(names).toContain('task_create');
    expect(names).toContain('task_list');
    expect(names).toContain('task_update');
    expect(names).toContain('task_delete');
    expect(names).toContain('web_search');
    expect(names).toContain('web_fetch');
    expect(names).toContain('file_list');
    expect(names).toContain('file_delete');
    expect(names).toContain('chunks_search');
    expect(names).toContain('spawn_agent');
    expect(names).toContain('memory_save');
  });

  it('each tool has OpenAI function calling format', () => {
    const defs = getToolDefinitions();
    for (const def of defs) {
      expect(def.type).toBe('function');
      expect(def.function.name).toBeTruthy();
      expect(def.function.description).toBeTruthy();
      expect(def.function.parameters.type).toBe('object');
      expect(def.function.parameters.properties).toBeDefined();
    }
  });
});

describe('getSubAgentToolDefinitions', () => {
  it('excludes spawn_agent from tool list', () => {
    const defs = getSubAgentToolDefinitions();
    const names = defs.map((d) => d.function.name);
    expect(names).not.toContain('spawn_agent');
    expect(names).toContain('task_create');
    expect(names).toContain('web_search');
    expect(names).toContain('chunks_search');
  });

  it('has exactly one fewer tool than full set', () => {
    const full = getToolDefinitions();
    const sub = getSubAgentToolDefinitions();
    expect(sub.length).toBe(full.length - 1);
  });
});

describe('dispatchTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches task_create correctly', async () => {
    (createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1, title: 'Test', status: 'pending', priority: 'medium',
    });

    const result = await dispatchTool('task_create', { title: 'Test' }, makeDeps());
    expect(createTask).toHaveBeenCalledWith(mockD1, { userId: 42, title: 'Test' });
    const parsed = JSON.parse(result);
    expect(parsed.id).toBe(1);
    expect(parsed.title).toBe('Test');
  });

  it('dispatches task_create with optional fields', async () => {
    (createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 2, title: 'Full', description: 'desc', status: 'pending', priority: 'high',
    });

    await dispatchTool('task_create', { title: 'Full', description: 'desc', priority: 'high' }, makeDeps());
    expect(createTask).toHaveBeenCalledWith(mockD1, {
      userId: 42, title: 'Full', description: 'desc', priority: 'high',
    });
  });

  it('dispatches task_list correctly', async () => {
    (listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, title: 'A' }, { id: 2, title: 'B' },
    ]);

    const result = await dispatchTool('task_list', {}, makeDeps());
    expect(listTasks).toHaveBeenCalledWith(mockD1, 42, undefined);
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(2);
  });

  it('dispatches task_update correctly', async () => {
    (updateTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 5, title: 'Updated', status: 'done',
    });

    const result = await dispatchTool('task_update', { id: 5, status: 'done' }, makeDeps());
    expect(updateTask).toHaveBeenCalledWith(mockD1, 5, { status: 'done' });
    const parsed = JSON.parse(result);
    expect(parsed.id).toBe(5);
  });

  it('dispatches task_delete correctly', async () => {
    (deleteTask as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const result = await dispatchTool('task_delete', { id: 3 }, makeDeps());
    expect(deleteTask).toHaveBeenCalledWith(mockD1, 3);
    const parsed = JSON.parse(result);
    expect(parsed.deleted).toBe(true);
  });

  it('dispatches web_search correctly', async () => {
    (serperSearch as ReturnType<typeof vi.fn>).mockResolvedValue([
      { title: 'A', link: 'https://a.com', snippet: 'sa' },
    ]);

    const result = await dispatchTool('web_search', { q: 'hello' }, makeDeps());
    expect(serperSearch).toHaveBeenCalledWith('hello', 'test-key');
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('A');
  });

  it('dispatches web_fetch correctly', async () => {
    (fetchUrl as ReturnType<typeof vi.fn>).mockResolvedValue('Hello world');

    const result = await dispatchTool('web_fetch', { url: 'https://example.com' }, makeDeps());
    expect(fetchUrl).toHaveBeenCalledWith('https://example.com');
    expect(result).toBe('Hello world');
  });

  it('dispatches file_list correctly', async () => {
    (listDocuments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, filename: 'a.pdf' },
    ]);

    const result = await dispatchTool('file_list', {}, makeDeps());
    expect(listDocuments).toHaveBeenCalledWith(mockD1, 42);
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
  });

  it('dispatches file_delete correctly', async () => {
    (deleteDocument as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (getChunkIdsByDoc as ReturnType<typeof vi.fn>).mockResolvedValue([1, 2]);

    const result = await dispatchTool('file_delete', { id: 10 }, makeDeps());
    expect(deleteDocument).toHaveBeenCalledWith(mockD1, 10);
    expect(mockQdrant.deleteByChunkIds).toHaveBeenCalledWith([1, 2]);
    const parsed = JSON.parse(result);
    expect(parsed.deleted).toBe(true);
  });

  it('dispatches chunks_search correctly', async () => {
    (chunksSearch as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, content: 'foo', score: 0.9, doc_id: 5 },
    ]);

    const result = await dispatchTool('chunks_search', { query: 'foo' }, makeDeps());
    expect(chunksSearch).toHaveBeenCalledWith('foo', 42, 'hybrid', {
      d1: mockD1, qdrant: mockQdrant, embedding: mockEmbedding,
    });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
  });

  it('dispatches chunks_search with custom mode', async () => {
    (chunksSearch as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await dispatchTool('chunks_search', { query: 'bar', mode: 'keyword' }, makeDeps());
    expect(chunksSearch).toHaveBeenCalledWith('bar', 42, 'keyword', {
      d1: mockD1, qdrant: mockQdrant, embedding: mockEmbedding,
    });
  });

  it('returns error for unknown tool', async () => {
    const result = await dispatchTool('unknown_tool', {}, makeDeps());
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('unknown_tool');
  });

  it('handles tool execution errors gracefully', async () => {
    (serperSearch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API down'));

    const result = await dispatchTool('web_search', { q: 'test' }, makeDeps());
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('API down');
  });

  it('memory_save inserts new chat memory', async () => {
    (insertChatMemory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 100, content: '用户喜欢中文', source: 'chat', user_id: 1, doc_id: null, expires_at: 'some-date' });
    mockQdrant.searchVectors.mockResolvedValueOnce([]);
    mockEmbedding.embed.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);

    const result = await dispatchTool('memory_save', {
      items: [{ content: '用户喜欢中文', category: 'preference' }],
    }, makeDeps());
    const parsed = JSON.parse(result);
    expect(parsed[0].status).toBe('saved');
    expect(mockQdrant.upsertVectors).toHaveBeenCalledTimes(1);
    const upsertCall = mockQdrant.upsertVectors.mock.calls[0][0][0];
    expect(upsertCall.payload.source).toBe('chat');
    expect(typeof upsertCall.id).toBe('number');
  });

  it('memory_save updates duplicate memory', async () => {
    (updateChatMemory as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    mockQdrant.searchVectors.mockResolvedValueOnce([
      { id: '50', score: 0.97, payload: { chunk_id: 50, source: 'chat', content: '旧内容' } },
    ]);
    mockEmbedding.embed.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);

    const result = await dispatchTool('memory_save', {
      items: [{ content: '新内容', category: 'fact' }],
    }, makeDeps());
    const parsed = JSON.parse(result);
    expect(parsed[0].status).toBe('updated');
    expect(updateChatMemory).toHaveBeenCalledWith(mockD1, 50, expect.objectContaining({ content: '新内容', category: 'fact' }));
  });
});
