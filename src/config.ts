export const config = {
  llm: {
    model: 'glm-5-turbo',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
  },
  vision: {
    model: 'glm-4.6v',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
  },
  embedding: {
    model: 'BAAI/bge-m3',
    baseUrl: 'https://api.siliconflow.cn/v1',
  },
  agent: {
    maxRounds: 30,
    ragTimeoutMs: 15_000,
    llmMaxRetries: 1,
    llmRetryDelayMs: 2_000,
    textFlushChars: 20,
    textFlushMs: 80,
  },
  search: {
    rrfK: 60,
    mmrLambda: 0.7,
    mmrTopK: 5,
    ftsLimit: 20,
    vectorLimit: 20,
  },
  chunker: {
    targetTokens: 500,
    overlapTokens: 75,
    windowTokens: 100,
    charsPerToken: 4,
  },
  web: {
    fetchTimeoutMs: 10_000,
    maxResponseBytes: 1_024 * 1024,
  },
  qdrant: {
    vectorSize: 1024,
    distance: 'Cosine' as const,
  },
  upload: {
    maxFileSize: 20 * 1024 * 1024,
    maxImageSize: 10 * 1024 * 1024,
    allowedMimeTypes: [
      'text/plain',
      'text/markdown',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
    ],
    allowedExtensions: ['txt', 'md', 'pdf', 'docx', 'jpg', 'jpeg', 'png', 'gif', 'webp'],
  },
};
