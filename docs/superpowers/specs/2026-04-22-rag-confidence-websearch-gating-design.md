# RAG 置信度驱动的 Web Search 门控设计

## 背景

当前 Agent 流程：用户消息 → RAG 检索 → 注入 system prompt → Agent 对话循环 → Agent 可主动调用 web_search。

问题：RAG 已有高质量匹配时，Agent 仍会不必要地调用 web_search，浪费 API 调用和延迟。

## 目标

在 Agent 交互前，根据 RAG 检索的向量相似度打分决定是否需要 Web Search：
- **top-1 向量分数 ≥ 0.8**：在 prompt 中引导 Agent 优先使用文档内容，无需 web_search
- **top-1 向量分数 < 0.8**：在 prompt 中引导 Agent 考虑用 web_search 补充信息
- **无 RAG 结果**：不追加引导（维持当前行为）

## 设计

### 1. 数据层：ChunkResult 扩展

**文件：`src/services/search.ts`**

`ChunkResult` 新增 `vectorScore?: number` 字段，透传 Qdrant 返回的原始 cosine 相似度（0~1）。

- `ChunkWithVector` 同步新增 `vectorScore` 字段
- **混合模式**：在 `candidates` 构建时从 `vecHit` 取 Qdrant 原始 score 填入 `vectorScore`。**关键**：`mmrRerank` 返回时必须透传 `vectorScore`（当前实现只映射 `{ id, content, score, doc_id }`，会丢弃该字段）
- **vector-only 模式**：`vectorSearch` 函数映射时需显式包含 `vectorScore: r.score`
- **keyword-only 模式**：`vectorScore` 为 undefined
- **混合模式向量为空退化为纯 FTS 时**（search.ts:144）：`vectorScore` 全部为 undefined，`topVectorScore` 为 0，行为等同于无 RAG 高分结果，符合预期

### 2. 决策层：doRagRetrieval 改造

**文件：`src/agent/loop.ts`**

`doRagRetrieval` 返回值从 `string` 改为 `{ context: string; topVectorScore: number }`。

逻辑：
1. 调用 `chunksSearch()` 拿到结果数组
2. 取 `results[0]?.vectorScore ?? 0` 作为 `topVectorScore`
3. `context` 按原逻辑拼接 content（空结果返回空字符串）
4. 超时和异常处理不变，异常时 `topVectorScore` 为 0

`execute` 方法中：
```typescript
const { context: ragContext, topVectorScore } = await this.doRagRetrieval(userMessage, userId);
const ragConfidence = ragContext.length === 0 ? 'none' : topVectorScore >= config.search.ragConfidenceThreshold ? 'high' : 'low';
```

将 `ragConfidence`（三态：`'high' | 'low' | 'none'`）传给 `buildSystemPrompt`。

使用三态而非布尔值，以区分「无 RAG 结果」和「有结果但分数低」两种情况。

### 3. Prompt 层：条件引导

**文件：`src/agent/prompt.ts`**

`buildSystemPrompt` 新增参数 `ragConfidence?: 'high' | 'low' | 'none'`。

在「相关文档」section 之后、`systemPromptExtra` 之前追加条件引导文案：

- **ragConfidence = 'high'**：`已从文档中检索到高质量匹配结果，请优先基于上述文档内容回答，无需使用 web_search。`
- **ragConfidence = 'low'**：`文档匹配度较低，如需更准确的信息，建议使用 web_search 补充。`
- **ragConfidence = 'none'** 或 undefined：不追加引导

### 4. 配置

**文件：`src/config.ts`**

在 `search` 配置中新增：
```typescript
ragConfidenceThreshold: 0.8,
```

用于控制门控阈值，避免硬编码。

## 测试

- **单元测试**：`chunksSearch` 各模式下 `vectorScore` 字段的正确填充
- **单元测试**：`doRagRetrieval` 返回结构化 `{ context, topVectorScore }`，含边界情况
- **单元测试**：`buildSystemPrompt` 的三种分支（high/low/none）输出正确引导文案
- 不需要新的集成测试，SSE 流程不变

## 影响范围

| 文件 | 改动 |
|------|------|
| `src/services/search.ts` | ChunkResult/ChunkWithVector 新增 vectorScore 字段，混合模式透传 |
| `src/agent/loop.ts` | doRagRetrieval 返回结构化结果，execute 中判断 ragHighConfidence |
| `src/agent/prompt.ts` | buildSystemPrompt 新增 ragConfidence 参数及条件引导 |
| `src/config.ts` | search.ragConfidenceThreshold |
