export class EmbeddingClient {
  constructor(private config: { apiKey: string; baseUrl: string; model: string }) {}

  async embed(texts: string[]): Promise<number[][]> {
    const url = `${this.config.baseUrl}/embeddings`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.config.model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as {
      data: { embedding: number[] }[];
    };
    return json.data.map((item) => item.embedding);
  }
}
