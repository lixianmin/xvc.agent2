# Deployment Guide

Step-by-step guide to deploy xvc-agent2 to Cloudflare Workers.

[中文部署指南](./deployment.zh-CN.md)

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- Node.js ≥ 18 installed locally
- API keys ready:
  - GLM API key (or any OpenAI-compatible LLM provider)
  - [Serper.dev](https://serper.dev/) API key
  - [Qdrant Cloud](https://cloud.qdrant.io/) cluster URL + API key

## Step 1: Install Wrangler CLI

```bash
npm install -g wrangler

# Login to your Cloudflare account
wrangler login
```

This opens a browser for OAuth. After authorization, you're ready.

## Step 2: Create D1 Database

```bash
npx wrangler d1 create xvc-agent2
```

Output looks like:

```
✅ Successfully created DB 'xvc-agent2'

[[d1_databases]]
binding = "DB"
database_name = "xvc-agent2"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy the `database_id` into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "xvc-agent2"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # ← paste here
```

## Step 3: Initialize Database Schema

```bash
npx wrangler d1 execute xvc-agent2 --remote --file=schema.sql
```

This creates all tables (users, tasks, threads, messages, documents, chunks, chunks_fts, outbox_events) in the remote D1 database.

Verify:

```bash
npx wrangler d1 execute xvc-agent2 --remote --command="SELECT name FROM sqlite_master WHERE type='table'"
```

## Step 4: Create R2 Bucket

```bash
npx wrangler r2 bucket create xvc-agent2-files
```

Verify:

```bash
npx wrangler r2 bucket list
```

## Step 5: Setup Qdrant

### Option A: Qdrant Cloud (recommended)

1. Go to [cloud.qdrant.io](https://cloud.qdrant.io/)
2. Create a free cluster
3. Note your cluster URL and API key
4. Create a collection:

```bash
curl -X PUT "https://YOUR_CLUSTER.qdrant.io/collections/xvc_agent_chunks" \
  -H "api-key: YOUR_QDRANT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "vectors": {
      "size": 1024,
      "distance": "Cosine"
    }
  }'
```

### Option B: Local Qdrant (for testing)

```bash
docker run -p 6333:6333 qdrant/qdrant
```

## Step 6: Set Worker Secrets

Set each environment variable as a Worker secret:

```bash
npx wrangler secret put GLM_API_KEY
# Paste your key when prompted

npx wrangler secret put SERPER_API_KEY
npx wrangler secret put QDRANT_URL
npx wrangler secret put QDRANT_API_KEY
npx wrangler secret put QDRANT_COLLECTION
```

Verify secrets are set:

```bash
npx wrangler secret list
```

## Step 7: Deploy

```bash
npm run deploy
```

Output:

```
Published xvc-agent2 (x.xx sec)
  https://xvc-agent2.<your-subdomain>.workers.dev
```

Open the URL in a browser. You should see the registration page.

## Step 8: Verify

1. **Register** — Enter email and name
2. **Chat** — Send "Hello" and verify AI responds
3. **Upload** — Upload a PDF/TXT file in Workspace tab
4. **Search** — Ask a question about the uploaded file
5. **Tasks** — Ask "Create a task called test"

## Troubleshooting

### D1 database not found

Make sure `database_id` in `wrangler.toml` matches the ID from `wrangler d1 create`.

### R2 bucket not found

Make sure the bucket name in `wrangler.toml` matches what you created. The name is `xvc-agent2-files`.

### Qdrant connection error

Verify the URL format: it should be `https://your-cluster.qdrant.io` (no trailing slash). Test with:

```bash
curl "https://YOUR_CLUSTER.qdrant.io/collections/xvc_agent_chunks" \
  -H "api-key: YOUR_QDRANT_API_KEY"
```

### LLM API error

Check that `GLM_API_KEY` is valid and the API is accessible from Cloudflare Workers (no IP whitelist blocking).

### View logs

```bash
npx wrangler tail
```

This streams real-time logs from the deployed worker.

## Updating

After code changes:

```bash
npm run deploy
```

For schema changes:

```bash
npx wrangler d1 execute xvc-agent2 --remote --command="YOUR SQL HERE"
```

## Cleanup

To tear down everything:

```bash
# Delete worker
npx wrangler delete xvc-agent2

# Delete D1 database
npx wrangler d1 delete xvc-agent2

# Delete R2 bucket (must be empty first)
npx wrangler r2 bucket delete xvc-agent2-files
```
