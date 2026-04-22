type QdrantPoint = {
  id: number | string;
  vector: number[];
  payload: Record<string, unknown>;
};

type SearchResult = {
  id: string;
  score: number;
  payload: Record<string, unknown>;
  vector?: number[];
};

export class QdrantDAO {
  private collectionName: string;
  private ensurePromise: Promise<void> | null = null;

  constructor(private config: { url: string; apiKey: string; collection?: string }) {
    this.collectionName = config.collection ?? 'chunks';
  }

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
    if (!this.ensurePromise) {
      this.ensurePromise = this.doEnsureCollection();
    }
    await this.ensurePromise;
  }

  private async doEnsureCollection(): Promise<void> {
    const res = await fetch(this.collectionUrl(''), { headers: this.headers() });
    if (res.ok) {
      await this.ensurePayloadIndexes();
      return;
    }
    if (res.status === 404) {
      const createRes = await fetch(this.collectionUrl(''), {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({ vectors: { size: 1024, distance: 'Cosine' } }),
      });
      if (!createRes.ok) {
        this.ensurePromise = null;
        const body = await createRes.text();
        throw new Error(`Failed to create Qdrant collection: ${createRes.status} ${body}`);
      }
      await this.ensurePayloadIndexes();
      return;
    }
    this.ensurePromise = null;
    throw new Error(`Failed to check collection: ${res.status}`);
  }

  private indexes: Record<string, string> = {
    user_id: 'integer',
    source: 'keyword',
    expires_at: 'datetime',
  };

  private async ensurePayloadIndexes(): Promise<void> {
    const existing = await this.getExistingIndexes();
    for (const [field, schema] of Object.entries(this.indexes)) {
      if (existing.includes(field)) continue;
      const res = await fetch(this.collectionUrl('/index'), {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({ field_name: field, field_schema: schema }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.warn(`Failed to create index ${field}: ${res.status} ${body}`);
      }
    }
  }

  private async getExistingIndexes(): Promise<string[]> {
    try {
      const res = await fetch(this.collectionUrl('/index'), { headers: this.headers() });
      if (!res?.ok) return [];
      const data = await res.json() as { result?: { index_type?: string; field_name?: string }[] };
      return (data.result ?? []).map((idx) => idx.field_name ?? '').filter(Boolean);
    } catch {
      return [];
    }
  }

  async upsertVectors(points: QdrantPoint[]): Promise<void> {
    await this.ensureCollection();
    const res = await fetch(this.collectionUrl('/points'), {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ points }),
    });
    if (!res.ok) throw new Error(`Qdrant upsert failed: ${res.status}`);
  }

  async searchVectors(query: number[], userId: number, limit: number, withVector = false): Promise<SearchResult[]> {
    await this.ensureCollection();
    const now = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').replace('Z', '');
    const body: Record<string, unknown> = {
      vector: query,
      filter: {
        must: [
          { key: 'user_id', match: { value: userId } },
          {
            should: [
              { is_empty: { key: 'source' } },
              { key: 'source', match: { value: 'document' } },
              {
                must: [
                  { key: 'source', match: { value: 'chat' } },
                  { is_empty: { key: 'expires_at' } },
                ],
              },
              {
                must: [
                  { key: 'source', match: { value: 'chat' } },
                  { key: 'expires_at', range: { gt: now } },
                ],
              },
            ],
          },
        ],
      },
      limit,
      with_payload: true,
    };
    if (withVector) body.with_vector = true;
    const res = await fetch(this.collectionUrl('/points/search'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Qdrant search failed: ${res.status}`);
    const data = await res.json();
    return data.result;
  }

  async deleteByChunkIds(chunkIds: number[]): Promise<void> {
    if (chunkIds.length === 0) return;
    const res = await fetch(this.collectionUrl('/points/delete'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ points: chunkIds }),
    });
    if (!res.ok) throw new Error(`Qdrant delete failed: ${res.status}`);
  }
}

export type { QdrantPoint, SearchResult };
