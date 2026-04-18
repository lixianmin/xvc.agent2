# Code Review Issues (2026-04-18)

Full project review — 2 Critical, 6 Important, 14 Minor. (C3, C4, C5, I1, I2, I3, I4, I5, I6, I7, I8, I9, I10, M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M11, M13, M14 fixed)

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

### ~~I1: LLMClient 非流式读取 — 全量缓冲~~ ✅ Fixed — 改用 `res.body.getReader()` 增量解析 SSE

### ~~I2: hybrid search 重复调用 embedding~~ ✅ Fixed — vectorSearchWithVectors 返回 queryVector 复用

### ~~I3: keywordSearch 返回 doc_id: 0~~ ✅ Fixed — searchFTS SQL 加 `c.doc_id`

### ~~I4: tool args JSON 解析失败静默吞错~~ ✅ Fixed — loop 层用 toolArgs map 直传，LLM client 层解析失败带 _parseError

### ~~I5: deleteByChunkIds 语义不精确~~ ✅ Fixed — 用 ids 数组直接删除

### ~~I6: parseInt 不检查 NaN~~ ✅ Fixed — parseId 工具函数 + 400 返回

### ~~I7: config.ts 值未被 service 使用~~ ✅ Fixed — search/chunker/web 均引用 config.*

### ~~I8: FTS 无同步触发器~~ ✅ Fixed — AFTER DELETE trigger on chunks 清理 chunks_fts

### ~~I9: 缺少索引~~ ✅ Fixed — 添加 chunks(doc_id), tasks(user_id, status), outbox_events(chunk_id)

## Minor

### ~~M1: ToolDef 类型从 llm/client import 但实际在 agent/tools 定义~~ ✅ Fixed — 删除 llm/client 重复定义，统一从 agent/tools 导入

### ~~M2: Document 类型重复定义 (d1.ts + upload.ts)，estimateTokens 重复 (d1.ts + chunker.ts)~~ ✅ Fixed — upload 导入 Document from d1；d1 导入 estimateTokens from chunker

### ~~M3: logger 时区~~ ✅ Fixed — 用 `toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })`

### ~~M4: createDocument 返回类型 Document|null 但内部 ! 断言~~ ✅ Fixed — 返回类型改为 `Document`

### ~~M5: 文件上传无类型/大小校验~~ ✅ Fixed — 校验扩展名 + 文件大小上限 (20MB)

### ~~M6: tools.ts 用 console.log 而非自定义 logger~~ ✅ Fixed — 改用 log.info()

### ~~M7: 前端 SSE 解析 catch {} 静默吞错~~ ✅ Fixed — 改为 `catch(e) { console.warn(...) }`

### ~~M8: escapeHtml 不转义引号~~ ✅ Fixed — 改用 replace 链转义 & < > " '

### ~~M9: 无 Content-Security-Policy header~~ ✅ Fixed — HTML 响应添加 CSP header

### ~~M10: userName[0].toUpperCase() 空字符串崩溃~~ ✅ Fixed — 加空字符回退 `(name[0] || 'X').toUpperCase()`

### ~~M11: 无 outbox DAO 测试~~ ✅ Fixed — `tests/unit/dao/outbox.test.ts` 已存在 (7 tests)

### M12: welcome card 中文硬编码在 HTML (Won't fix — 目标用户为中文用户)
- **位置**: `public/index.html:67-86`

### ~~M13: vitest 无 coverage 配置~~ ✅ Fixed — 添加 v8 provider + 80% threshold

### ~~M14: loadMessages 排序用 indexOf，O(n²)~~ ✅ Fixed — 改用 Map<number, number> 索引
