# xvc-agent2

基于 AI Agent 的智能对话式任务管理助手，部署在 Cloudflare Workers 上。

[English Documentation](./README.md)

## 功能特性

- **对话式任务管理** — 通过自然语言创建、更新、查询、删除任务
- **AI 子代理系统** — 复杂研究任务自动拆解，子代理并行执行、上下文隔离
- **混合 RAG 检索** — FTS5 关键词 + Qdrant 向量搜索，RRF 融合 + MMR 重排，兼顾相关性与多样性
- **文件处理流水线** — 上传 PDF/DOCX/TXT/MD/图片 → 自动解析 → 分块 → 向量化 → 存储
- **图片 OCR** — 上传图片通过 GLM-4.6V 进行 OCR 识别，提取文字入 RAG
- **长期记忆** — 用户偏好和事实通过 `memory_save` 工具持久化，跨对话召回
- **网络搜索集成** — 通过 Serper.dev 实时检索互联网信息
- **流式对话** — SSE 实时响应，带标点/大小智能 flush

## 架构设计

```
Cloudflare Worker (Hono)
├── src/index.ts          — API 路由 + 静态文件服务
├── src/agent/
│   ├── loop.ts           — AsyncGenerator 驱动的 Agent Loop（SSE/内存双模式）
│   ├── sub-agent.ts      — 子代理创建，heartbeat 超时机制
│   ├── tools.ts          — 11 个工具定义 + 约定式分发
│   └── prompt.ts         — System prompt 构建器
├── src/llm/
│   ├── client.ts         — LLM 客户端（OpenAI 兼容，流式输出）
│   └── embedding.ts      — Embedding 客户端
├── src/dao/
│   ├── d1.ts             — D1 操作（用户、任务、线程、消息、文档、分块）
│   ├── qdrant.ts         — Qdrant HTTP API
│   └── outbox.ts         — Outbox 保证 D1↔Qdrant 数据一致性
├── src/services/
│   ├── search.ts         — 混合搜索：FTS5 + Qdrant → RRF 融合 + MMR 重排
│   ├── upload.ts         — R2 → 解析 → 清洗 → 分块 → 向量化 → Qdrant
│   ├── web.ts            — Serper 搜索 + URL 抓取
│   └── ...
└── public/               — 原生 HTML/CSS/JS 前端（无构建步骤）
```

### Agent Loop 设计

核心 `AgentLoop.execute()` 返回 `AsyncGenerator<AgentEvent>`，业务逻辑与输出方式解耦：

- `run()` — SSE 薄包装（用于浏览器对话）
- `runSub()` — 内存收集薄包装（用于子代理）
- 子代理通过 `spawn_agent` 工具创建，`Promise.allSettled` 并行执行
- Heartbeat 超时机制：10 秒无事件自动中止

### 子代理执行流程

```
用户提出复杂研究问题
  → 主代理调用 spawn_agent({ tasks: ["任务 A", "任务 B"] })
    → Promise.allSettled([
        runSub(deps, "sub-0", userId, "任务 A"),
        runSub(deps, "sub-1", userId, "任务 B"),
      ])
    → 每个子代理：独立 AgentLoop 实例，最多 15 轮，工具集不含 spawn_agent
  → 主代理汇总子代理结果，生成最终回答
```

### RAG 检索流程

```
用户上传文件 → R2 存储
  → Parser (PDF/DOCX/TXT/MD → 纯文本)
  → Cleaner (去空白、控制字符、HTML、NFC 归一化)
  → Chunker (标题感知分块，~500 tokens，15% overlap)
  → Embedder (SiliconFlow bge-m3 embedding)
  → Qdrant upsert + D1 chunks 写入 + FTS5 索引

用户提问 → Hybrid Search
  → FTS5 关键词搜索 (BM25)
  → Qdrant 向量搜索
  → RRF 融合排序
  → MMR 多样性重排
  → Top-K 结果注入 system prompt 作为 RAG 上下文
```

## 技术栈

- **运行时**: Cloudflare Workers
- **框架**: Hono
- **LLM**: GLM API（OpenAI 兼容接口，流式输出）
- **向量数据库**: Qdrant Cloud
- **关系数据库**: Cloudflare D1 (SQLite)
- **文件存储**: Cloudflare R2
- **搜索 API**: Serper.dev
- **前端**: 原生 HTML + CSS + JavaScript（无构建步骤）
- **测试**: Vitest + `@cloudflare/vitest-pool-workers`

## 本地开发

### 前置条件

- Node.js ≥ 18
- Cloudflare 账号（用于 D1、R2、Workers）
- 相关 API Key（见下方）

### 安装

```bash
# 克隆仓库
git clone https://github.com/lixianmin/xvc.agent2.git
cd xvc-agent2

# 安装依赖
npm install

# 创建本地开发配置
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars 填入你的 API Key
```

### 环境变量

在项目根目录创建 `.dev.vars`：

```
GLM_API_KEY=你的_glm_api_key
SILICONFLOW_API_KEY=你的_siliconflow_api_key
SERPER_API_KEY=你的_serper_api_key
QDRANT_URL=https://你的集群.qdrant.io
QDRANT_API_KEY=你的_qdrant_api_key
QDRANT_COLLECTION=xvc_agent_chunks
```

### 初始化本地数据库

```bash
# 在本地创建 D1 数据库并执行 schema
npx wrangler d1 execute xvc-agent2 --local --file=schema.sql
```

### 启动开发服务器

```bash
npm run dev
# 访问 http://localhost:8787
```

### 运行测试

```bash
# 运行全部测试（211 tests, 17 files）
npm test

# 监听模式
npm run test:watch
```

## 部署

详见 [部署指南](./docs/deployment.zh-CN.md)。

## 实现说明文档

详见 [实现说明文档](./docs/04.implementation-notes.md)，包含：需求完成度总览、整体架构、子代理实现、RAG 检索流程、文件处理管道、挑战与解决方案。

快速版：

```bash
# 1. 创建 D1 数据库
npx wrangler d1 create xvc-agent2
# 将返回的 database_id 更新到 wrangler.toml

# 2. 初始化数据库 Schema
npx wrangler d1 execute xvc-agent2 --remote --file=schema.sql

# 3. 创建 R2 存储桶
npx wrangler r2 bucket create xvc-agent2-files

# 4. 创建 Qdrant Collection（通过 Qdrant 控制台或 API）

# 5. 设置 Worker 密钥
npx wrangler secret put GLM_API_KEY
npx wrangler secret put SILICONFLOW_API_KEY
npx wrangler secret put SERPER_API_KEY
npx wrangler secret put QDRANT_URL
npx wrangler secret put QDRANT_API_KEY
npx wrangler secret put QDRANT_COLLECTION

# 6. 部署
npm run deploy
```

## 项目结构

```
├── src/
│   ├── index.ts              # Hono 应用入口
│   ├── config.ts             # 配置
│   ├── agent/                # AI Agent 核心
│   ├── llm/                  # LLM & Embedding 客户端
│   ├── dao/                  # 数据访问层（D1, Qdrant, Outbox）
│   ├── services/             # 业务逻辑（搜索、上传、网络等）
│   └── middleware/            # 认证中间件
├── public/                   # 前端（HTML/CSS/JS）
├── tests/
│   ├── unit/                 # 17 个测试文件，211 个测试用例
│   └── integration/          # Curl 集成测试
├── docs/                     # 规范、计划、记忆
├── schema.sql                # D1 数据库 Schema
└── wrangler.toml             # Cloudflare Worker 配置
```

## 实现说明

### 子代理规划的具体实现

主代理通过 `spawn_agent` 工具创建 1-3 个子代理，每个子代理是独立的 `AgentLoop` 实例，拥有隔离的 system prompt 和 messages 数组。子代理的工具集排除了 `spawn_agent`（防止嵌套），最多 15 轮。执行结果通过 `Promise.allSettled` 收集，失败的子代理返回错误信息而非导致整体失败。超时采用 heartbeat 机制：每收到一个 generator 事件重置 10s 计时器，连续 10s 无事件判定超时。

### 记忆召回（RAG）的设计与流程

采用混合搜索策略：FTS5 关键词搜索（BM25 评分）+ Qdrant 向量搜索（余弦相似度），通过 RRF（Reciprocal Rank Fusion）融合排序，再经 MMR（Maximal Marginal Relevance）重排以提升结果多样性。文件上传后经过解析（PDF/DOCX/TXT/MD）、清洗（空白/控制字符/HTML/NFC 归一化）、标题感知分块（~500 tokens，15% overlap）、向量化（GLM embedding），写入 D1 + Qdrant + FTS5 索引。通过 Outbox 模式保证 D1 与 Qdrant 的最终一致性。

### 文件处理与向量化细节

- **解析**: PDF (unpdf)、DOCX (mammoth)、TXT/MD (直接读取)、图片 (GLM-4.6V OCR)
- **分块**: 基于 Markdown 标题的感知分块器，保留标题层级上下文
- **向量化**: SiliconFlow BAAI/bge-m3，维度 1024
- **存储**: 文件存 R2，分块元数据存 D1 chunks 表，向量存 Qdrant
- **搜索**: 支持 keyword/vector/hybrid 三种模式

## License

Apache-2.0
