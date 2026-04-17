import { searchFTS } from '../dao/d1';
import { QdrantDAO } from '../dao/qdrant';
import { EmbeddingClient } from '../llm/embedding';

type SearchCandidate = { id: number | string };
type ScoredCandidate = { id: number | string; score: number };

export function reciprocalRankFusion(
  lists: SearchCandidate[][],
  weights: number[],
  k = 60,
): ScoredCandidate[] {
  const scores = new Map<number | string, number>();

  for (let li = 0; li < lists.length; li++) {
    const list = lists[li];
    const weight = weights[li] ?? 1;
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank].id;
      const current = scores.get(id) ?? 0;
      let bonus = 0;
      if (rank === 0) bonus = 0.05;
      else if (rank <= 2) bonus = 0.02;
      scores.set(id, current + weight / (k + rank + 1) + bonus);
    }
  }

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

type ChunkResult = { id: number; content: string; score: number; doc_id: number };
type ChunkWithVector = ChunkResult & { vector?: number[] };

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

export function mmrRerank(
  candidates: ChunkWithVector[],
  queryVector: number[],
  lambda = 0.7,
  topK = 5,
): ChunkResult[] {
  if (candidates.length <= topK) return candidates;

  const selected: number[] = [];
  const remaining = new Set(candidates.map((_, i) => i));
  const querySims = candidates.map((c) =>
    c.vector ? cosineSim(c.vector, queryVector) : 0,
  );

  for (let step = 0; step < topK && remaining.size > 0; step++) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (const idx of remaining) {
      const relevance = querySims[idx];
      let maxSep = 0;
      for (const selIdx of selected) {
        if (!candidates[selIdx].vector || !candidates[idx].vector) continue;
        const sim = cosineSim(candidates[idx].vector!, candidates[selIdx].vector!);
        if (sim > maxSep) maxSep = sim;
      }
      const score = lambda * relevance - (1 - lambda) * maxSep;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    }

    if (bestIdx === -1) break;
    selected.push(bestIdx);
    remaining.delete(bestIdx);
  }

  for (const idx of remaining) {
    if (selected.length >= topK) break;
    selected.push(idx);
  }

  return selected.map((idx) => ({
    id: candidates[idx].id,
    content: candidates[idx].content,
    score: candidates[idx].score,
    doc_id: candidates[idx].doc_id,
  }));
}

export async function chunksSearch(
  query: string,
  userId: number,
  mode: 'keyword' | 'vector' | 'hybrid',
  deps: {
    d1: D1Database;
    qdrant: QdrantDAO;
    embedding: EmbeddingClient;
  },
): Promise<ChunkResult[]> {
  if (mode === 'keyword') {
    return keywordSearch(deps.d1, query);
  }

  if (mode === 'vector') {
    return vectorSearch(deps.embedding, deps.qdrant, query, userId);
  }

  const [ftsResults, vectorResults] = await Promise.allSettled([
    keywordSearch(deps.d1, query),
    vectorSearchWithVectors(deps.embedding, deps.qdrant, query, userId),
  ]);

  const fts = ftsResults.status === 'fulfilled' ? ftsResults.value : [];
  const vec = vectorResults.status === 'fulfilled'
    ? vectorResults.value
    : (() => {
        console.warn('Qdrant search failed, falling back to keyword-only results');
        return [];
      })();

  if (vec.length === 0) return fts;

  const ftsList: SearchCandidate[] = fts.map((r) => ({ id: r.id }));
  const vecList: SearchCandidate[] = vec.map((r) => ({ id: r.id }));
  const fused = reciprocalRankFusion([ftsList, vecList], [1, 1]);

  const ftsMap = new Map(fts.map((r) => [r.id, r]));
  const vecMap = new Map(vec.map((r) => [r.id, r]));

  const candidates: ChunkWithVector[] = fused.map((item) => {
    const ftsHit = ftsMap.get(item.id as number);
    const vecHit = vecMap.get(item.id as number);
    return {
      id: item.id as number,
      content: ftsHit?.content ?? vecHit?.content ?? '',
      score: item.score,
      doc_id: ftsHit?.doc_id ?? vecHit?.doc_id ?? 0,
      vector: vecHit?.vector,
    };
  });

  const [queryVec] = await deps.embedding.embed([query]);
  return mmrRerank(candidates, queryVec, 0.7, 5);
}

async function keywordSearch(d1: D1Database, query: string): Promise<ChunkResult[]> {
  const results = await searchFTS(d1, query);
  return results.map((r) => ({ id: r.id, content: r.content, score: r.score, doc_id: 0 }));
}

async function vectorSearch(
  embedding: EmbeddingClient,
  qdrant: QdrantDAO,
  query: string,
  userId: number,
): Promise<ChunkResult[]> {
  const [vec] = await embedding.embed([query]);
  const results = await qdrant.searchVectors(vec, userId, 20);
  return results.map((r) => ({
    id: r.payload.chunk_id as number,
    content: (r.payload.content as string) ?? '',
    score: r.score,
    doc_id: (r.payload.doc_id as number) ?? 0,
  }));
}

async function vectorSearchWithVectors(
  embedding: EmbeddingClient,
  qdrant: QdrantDAO,
  query: string,
  userId: number,
): Promise<ChunkWithVector[]> {
  const [vec] = await embedding.embed([query]);
  const results = await qdrant.searchVectors(vec, userId, 20, true);
  return results.map((r) => ({
    id: r.payload.chunk_id as number,
    content: (r.payload.content as string) ?? '',
    score: r.score,
    doc_id: (r.payload.doc_id as number) ?? 0,
    vector: r.vector as number[] | undefined,
  }));
}
