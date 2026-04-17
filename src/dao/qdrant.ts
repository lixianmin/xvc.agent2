type QdrantPoint = {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
};

type SearchResult = {
  id: string;
  score: number;
  payload: Record<string, unknown>;
};

export class QdrantDAO {
  private collectionName = 'chunks';

  constructor(private config: { url: string; apiKey: string }) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'api-key': this.config.apiKey,
    };
  }

  private collectionUrl(path: string): string {
    return `${this.config.url}/collections/${this.collectionName}${path}`;
  }

  async ensureCollection(): Promise<void> {
    const res = await fetch(this.collectionUrl(''), { headers: this.headers() });
    if (res.ok) return;
    if (res.status === 404) {
      await fetch(this.collectionUrl(''), {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({ vectors: { size: 1024, distance: 'Cosine' } }),
      });
      return;
    }
    throw new Error(`Failed to check collection: ${res.status}`);
  }

  async upsertVectors(points: QdrantPoint[]): Promise<void> {
    await fetch(this.collectionUrl('/points'), {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ points }),
    });
  }

  async searchVectors(query: number[], userId: number, limit: number): Promise<SearchResult[]> {
    const res = await fetch(this.collectionUrl('/points/search'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        vector: query,
        filter: { must: [{ key: 'user_id', match: { value: userId } }] },
        limit,
        with_payload: true,
      }),
    });
    const data = await res.json();
    return data.result;
  }

  async deleteByChunkIds(chunkIds: number[]): Promise<void> {
    await fetch(this.collectionUrl('/points/delete'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        filter: {
          should: chunkIds.map((id) => ({ key: 'chunk_id', match: { value: id } })),
        },
      }),
    });
  }
}

export type { QdrantPoint, SearchResult };
