import { describe, it, expect, vi } from 'vitest';
import { reciprocalRankFusion, chunksSearch, mmrRerank } from '../../../src/services/search';

describe('reciprocalRankFusion', () => {
  it('fuses two ranked lists with correct scores', () => {
    const listA = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const listB = [{ id: 3 }, { id: 1 }, { id: 4 }];
    const result = reciprocalRankFusion([listA, listB], [1, 1]);

    const byId = new Map(result.map((r) => [r.id, r.score]));

    const k = 60;
    const score1 = 1 / (k + 0 + 1) + 0.05 + 1 / (k + 1 + 1) + 0.02;
    const score3 = 1 / (k + 2 + 1) + 0.02 + 1 / (k + 0 + 1) + 0.05;

    expect(byId.get(1)).toBeCloseTo(score1, 10);
    expect(byId.get(3)).toBeCloseTo(score3, 10);

    const sorted = [...result].sort((a, b) => b.score - a.score);
    expect(result).toEqual(sorted);
  });

  it('applies top-rank bonus (rank #1 gets +0.05)', () => {
    const listA = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const listB = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = reciprocalRankFusion([listA, listB], [1, 1]);

    const k = 60;
    const rawScore1 = 1 / (k + 0 + 1) + 1 / (k + 0 + 1);
    const expected1 = rawScore1 + 0.05 * 2;

    const rawScore2 = 1 / (k + 1 + 1) + 1 / (k + 1 + 1);
    const expected2 = rawScore2 + 0.02 * 2;

    const byId = new Map(result.map((r) => [r.id, r.score]));
    expect(byId.get(1)).toBeCloseTo(expected1, 10);
    expect(byId.get(2)).toBeCloseTo(expected2, 10);
  });

  it('handles empty lists', () => {
    expect(reciprocalRankFusion([], [])).toEqual([]);
    expect(reciprocalRankFusion([[]], [1])).toEqual([]);
    expect(reciprocalRankFusion([[], []], [1, 1])).toEqual([]);
  });

  it('handles single list', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const result = reciprocalRankFusion([list], [1]);

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('a');
    expect(result[result.length - 1].id).toBe('c');
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });
});

describe('chunksSearch', () => {
  const mockFTSResults = [
    { id: 1, content: 'hello world', score: -1.5 },
    { id: 2, content: 'foo bar', score: -2.0 },
  ];

  const mockVectorResults = [
    { id: '2', score: 0.9, payload: { chunk_id: 2, doc_id: 10 } },
    { id: '3', score: 0.8, payload: { chunk_id: 3, doc_id: 11 } },
  ];

  function makeDeps(overrides: Record<string, unknown> = {}) {
    const d1 = {
      prepare: vi.fn().mockReturnThis(),
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: mockFTSResults }),
      first: vi.fn(),
      run: vi.fn(),
    };

    const qdrant = {
      searchVectors: vi.fn().mockResolvedValue(mockVectorResults),
    };

    const embedding = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    };

    return { d1, qdrant, embedding, ...overrides };
  }

  it('in keyword mode returns FTS results', async () => {
    const deps = makeDeps();
    const result = await chunksSearch('test query', 1, 'keyword', deps);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 1, content: 'hello world', score: -1.5, doc_id: expect.any(Number) });
    expect(deps.qdrant.searchVectors).not.toHaveBeenCalled();
    expect(deps.embedding.embed).not.toHaveBeenCalled();
  });

  it('in hybrid mode combines FTS + vector results via RRF', async () => {
    const deps = makeDeps();
    const result = await chunksSearch('test query', 1, 'hybrid', deps);

    expect(deps.embedding.embed).toHaveBeenCalledWith(['test query']);
    expect(deps.qdrant.searchVectors).toHaveBeenCalled();

    const ids = result.map((r) => r.id);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
  });

  it('falls back to keyword-only when Qdrant fails', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps();
    deps.qdrant.searchVectors.mockRejectedValue(new Error('Qdrant down'));

    const result = await chunksSearch('test query', 1, 'hybrid', deps);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });
});

describe('mmrRerank', () => {
  function makeVec(angle: number, dim = 8): number[] {
    return Array.from({ length: dim }, (_, i) => (i === 0 ? Math.cos(angle) : Math.sin(angle)));
  }

  it('selects diverse candidates over similar ones', () => {
    const queryVec = makeVec(0);
    const candidates = [
      { id: 1, content: 'a', score: 1, doc_id: 0, vector: makeVec(0.1) },
      { id: 2, content: 'b', score: 1, doc_id: 0, vector: makeVec(0.15) },
      { id: 3, content: 'c', score: 1, doc_id: 0, vector: makeVec(1.5) },
    ];

    const result = mmrRerank(candidates, queryVec, 0.5, 3);

    expect(result).toHaveLength(3);
    const ids = result.map((r) => r.id);
    expect(ids[0]).toBe(1);
    expect(ids).toContain(3);
  });

  it('returns all candidates when fewer than topK', () => {
    const queryVec = [1, 0, 0];
    const candidates = [
      { id: 1, content: 'a', score: 1, doc_id: 0, vector: [1, 0, 0] },
      { id: 2, content: 'b', score: 1, doc_id: 0, vector: [0, 1, 0] },
    ];

    const result = mmrRerank(candidates, queryVec, 0.7, 5);
    expect(result).toHaveLength(2);
  });

  it('handles candidates without vectors', () => {
    const queryVec = [1, 0, 0];
    const candidates = [
      { id: 1, content: 'a', score: 1, doc_id: 0 },
      { id: 2, content: 'b', score: 1, doc_id: 0, vector: [0, 1, 0] },
    ];

    const result = mmrRerank(candidates, queryVec, 0.7, 2);
    expect(result).toHaveLength(2);
  });
});
