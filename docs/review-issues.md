# Code Review Issues (2026-04-18)

Full project review — 2 Critical, 8 Important, 14 Minor. (C3, C4, C5, I2, I3 fixed)

## Critical

### C1: 无真实认证 — X-User-Id 完全信任客户端
- **位置**: `src/middleware/auth.ts`
- **问题**: 任何客户端可通过设置 `X-User-Id` header 冒充任意用户
- **影响**: 所有用户数据可被任意访问/篡改，生产部署阻塞项
- **修复方向**: JWT / Cloudflare Access headers / session token

### C2: 无授权检查 — mutation 路由不验证数据所属用户
- **位置**: `src/index.ts` 各 POST 路由 (deleteThread, updateThreadTitle, deleteTask, deleteDocument 等)
- **问题**: 只检查用户身份，不验证目标资源属于该用户
- **影响**: 知道 ID 即可操作他人数据
- **修复方向**: 每个 mutation 操作前加 ownership check

### ~~C3: SSRF~~ ✅ Fixed (a8d24fe)

### ~~C4: deleteDocument 不删 D1 chunks~~ ✅ Fixed

### ~~C5: outbox 并发竞争~~ ✅ Fixed — claimEvent 乐观锁

## Important

### I1: LLMClient 非流式读取 — 全量缓冲
- **位置**: `src/llm/client.ts:43`
- **问题**: `res.text()` 一次性读取整个 LLM 响应，然后才遍历 SSE 事件
- **影响**: 丧失流式延迟优势，首 token 等待时间长
- **修复方向**: 用 `res.body.getReader()` 增量处理 SSE

### ~~I2: hybrid search 重复调用 embedding~~ ✅ Fixed — vectorSearchWithVectors 返回 queryVector 复用

### ~~I3: keywordSearch 返回 doc_id: 0~~ ✅ Fixed — searchFTS SQL 加 `c.doc_id`

### I4: tool args JSON 解析失败静默吞错
- **位置**: `src/agent/loop.ts:260`
- **问题**: `try { args = JSON.parse(tc.function.arguments); } catch {}` — 解析失败传入空 `{}`
- **影响**: 静默错误行为，如 `task_delete` 无 `id`
- **修复方向**: 解析失败返回错误 tool_result

### I5: deleteByChunkIds 语义不精确
- **位置**: `src/dao/qdrant.ts:73-83`
- **问题**: 用 `should` (OR) filter 删除，应用 points API 直接删除
- **影响**: 功能正确但语义不精确，可能误删
- **修复方向**: 用 `POST /collections/{name}/points { ids: [...] }`

### I6: parseInt 不检查 NaN
- **位置**: `src/index.ts:45,58,71,111,153`
- **问题**: `parseInt(queryParam)` 无 radix，空参数返回 `NaN` 传入 DAO
- **影响**: `loadMessages(DB, NaN)` 等无意义查询
- **修复方向**: parse 后检查 `isNaN`，返回 400

### I7: config.ts 值未被 service 使用
- **位置**: `src/config.ts` vs `src/services/search.ts`, `chunker.ts`, `web.ts`
- **问题**: config 定义了 rrfK, mmrLambda, mmrTopK 等，但 service 硬编码常量
- **影响**: 配置不生效，调整需改代码
- **修复方向**: service 引用 `config.*`

### I8: FTS 无同步触发器
- **位置**: `schema.sql`
- **问题**: `chunks_fts` 用 content-sync 模式但无 AFTER DELETE/UPDATE 触发器
- **影响**: 删 chunk 后 FTS 索引残留，搜索返回已删内容
- **修复方向**: 添加触发器或改用 contentless 模式

### I9: 缺少索引
- **位置**: `schema.sql`
- **问题**: 缺 `chunks(doc_id)`, `tasks(user_id, status)`, `outbox_events(chunk_id)`
- **影响**: 查询性能
- **修复方向**: 添加三个索引

### I10: spawn_agent 无单元测试，runSub timeout 被 skip
- **位置**: `tests/unit/agent/loop.test.ts:358`
- **问题**: 关键安全机制（子代理超时）未测试
- **修复方向**: 用 `vi.useFakeTimers()` 测试

## Minor

### M1: ToolDef 类型从 llm/client import 但实际在 agent/tools 定义
- **位置**: `src/agent/prompt.ts:1`

### M2: Document 类型重复定义 (d1.ts + upload.ts)，estimateTokens 重复 (d1.ts + chunker.ts)
- **位置**: `src/dao/d1.ts`, `src/services/upload.ts`, `src/services/chunker.ts`

### M3: Logger 时区用 Date.now() + 8h 伪造
- **位置**: `src/services/logger.ts:4`
- **修复**: 用 `toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })`

### M4: createDocument 返回类型 Document|null 但内部 ! 断言
- **位置**: `src/dao/d1.ts:334`
- **修复**: 改返回类型为 `Document`

### M5: 文件上传无类型/大小校验
- **位置**: `src/index.ts:136-150`

### M6: tools.ts 用 console.log 而非自定义 logger
- **位置**: `src/agent/tools.ts:261`

### M7: 前端 SSE 解析 catch {} 静默吞错
- **位置**: `public/app.js:566`
- **修复**: `catch(e) { console.warn('SSE parse error:', e, data); }`

### M8: escapeHtml 不转义引号
- **位置**: `public/app.js:17-21`
- **影响**: 如果用在 HTML 属性值中有 XSS 风险（当前只用在 textContent，安全）

### M9: 无 Content-Security-Policy header
- **位置**: `src/index.ts`

### M10: userName[0].toUpperCase() 空字符串崩溃
- **位置**: `public/app.js:328,346`

### M11: 无 outbox DAO 测试
- **位置**: 缺少 `tests/unit/dao/outbox.test.ts`

### M12: welcome card 中文硬编码在 HTML 中
- **位置**: `public/index.html:67-86`

### M13: vitest 无 coverage 配置
- **位置**: `vitest.config.mts`

### M14: loadMessages 排序用 indexOf，O(n²)
- **位置**: `src/dao/d1.ts:266`
- **修复**: 先建 Map<number, number> 再排序
