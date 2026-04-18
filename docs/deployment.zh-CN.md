# 部署指南

xvc-agent2 部署到 Cloudflare Workers 的详细步骤。

[English Deployment Guide](./deployment.md)

## 前置条件

- 一个 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)
- 本地安装 Node.js ≥ 18
- 准备好以下 API Key：
  - GLM API Key（或其他 OpenAI 兼容的 LLM 提供商）
  - [Serper.dev](https://serper.dev/) API Key
  - [Qdrant Cloud](https://cloud.qdrant.io/) 集群 URL + API Key

## 第 1 步：安装 Wrangler CLI

```bash
npm install -g wrangler

# 登录 Cloudflare 账号
wrangler login
```

会打开浏览器进行 OAuth 授权，授权完成后即可操作。

## 第 2 步：创建 D1 数据库

```bash
npx wrangler d1 create xvc-agent2
```

输出类似：

```
✅ Successfully created DB 'xvc-agent2'

[[d1_databases]]
binding = "DB"
database_name = "xvc-agent2"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

把 `database_id` 复制到 `wrangler.toml` 中：

```toml
[[d1_databases]]
binding = "DB"
database_name = "xvc-agent2"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # ← 粘贴到这里
```

## 第 3 步：初始化数据库 Schema

```bash
npx wrangler d1 execute xvc-agent2 --remote --file=schema.sql
```

这会创建所有表（users, tasks, threads, messages, documents, chunks, chunks_fts, outbox_events）。

验证：

```bash
npx wrangler d1 execute xvc-agent2 --remote --command="SELECT name FROM sqlite_master WHERE type='table'"
```

## 第 4 步：创建 R2 存储桶

```bash
npx wrangler r2 bucket create xvc-agent2-files
```

验证：

```bash
npx wrangler r2 bucket list
```

## 第 5 步：配置 Qdrant

### 方案 A：Qdrant Cloud（推荐）

1. 访问 [cloud.qdrant.io](https://cloud.qdrant.io/)
2. 创建免费集群
3. 记录集群 URL 和 API Key
4. 创建 Collection：

```bash
curl -X PUT "https://你的集群.qdrant.io/collections/xvc_agent_chunks" \
  -H "api-key: 你的_QDRANT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "vectors": {
      "size": 1024,
      "distance": "Cosine"
    }
  }'
```

### 方案 B：本地 Qdrant（用于测试）

```bash
docker run -p 6333:6333 qdrant/qdrant
```

## 第 6 步：设置 Worker 密钥

逐个设置环境变量作为 Worker Secret：

```bash
npx wrangler secret put GLM_API_KEY
# 按提示粘贴你的 Key

npx wrangler secret put SERPER_API_KEY
npx wrangler secret put QDRANT_URL
npx wrangler secret put QDRANT_API_KEY
npx wrangler secret put QDRANT_COLLECTION
```

验证密钥已设置：

```bash
npx wrangler secret list
```

## 第 7 步：部署

```bash
npm run deploy
```

输出：

```
Published xvc-agent2 (x.xx sec)
  https://xvc-agent2.<你的子域名>.workers.dev
```

在浏览器打开这个 URL，应该能看到注册页面。

## 第 8 步：验证

1. **注册** — 输入邮箱和姓名
2. **对话** — 发送 "你好"，确认 AI 有回复
3. **上传** — 在工作空间标签页上传一个 PDF/TXT 文件
4. **搜索** — 提问关于上传文件的问题
5. **任务** — 说 "创建一个任务叫测试"

## 常见问题

### D1 数据库未找到

确认 `wrangler.toml` 中的 `database_id` 与 `wrangler d1 create` 输出的一致。

### R2 存储桶未找到

确认 `wrangler.toml` 中的存储桶名与创建的一致，名称为 `xvc-agent2-files`。

### Qdrant 连接错误

确认 URL 格式正确：`https://你的集群.qdrant.io`（末尾无斜杠）。测试：

```bash
curl "https://你的集群.qdrant.io/collections/xvc_agent_chunks" \
  -H "api-key: 你的_QDRANT_API_KEY"
```

### LLM API 报错

检查 `GLM_API_KEY` 是否有效，以及 API 是否允许 Cloudflare Workers 的 IP 访问。

### 查看实时日志

```bash
npx wrangler tail
```

这会实时流式输出 Worker 的日志。

## 更新

代码变更后：

```bash
npm run deploy
```

数据库 Schema 变更：

```bash
npx wrangler d1 execute xvc-agent2 --remote --command="你的 SQL 语句"
```

## 清理

卸载所有资源：

```bash
# 删除 Worker
npx wrangler delete xvc-agent2

# 删除 D1 数据库
npx wrangler d1 delete xvc-agent2

# 删除 R2 存储桶（需先清空）
npx wrangler r2 bucket delete xvc-agent2-files
```
