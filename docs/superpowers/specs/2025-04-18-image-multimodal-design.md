# P5: 图片多模态支持设计

## 背景

原始需求 §3 要求支持图片上传并提取信息（OCR），将结果纳入 RAG 检索。

当前文件上传 pipeline 支持 PDF/DOCX/TXT/MD → parse → clean → chunk → embed → Qdrant。本次扩展支持图片类型（JPG/PNG/GIF/WebP），利用 GLM-5V-Turbo 视觉模型提取图片中的文字和内容描述，文本结果走现有 RAG pipeline。

## 数据流

```
用户上传图片 (JPG/PNG/GIF/WebP, ≤10MB)
  → R2 存储（原图）
  → base64 编码
  → GLM-5V-Turbo chat/completions (非流式)
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } },
      { type: "text", text: "请提取图片中的所有文字内容..." }
    ]}]
  → 返回文本描述
  → clean → chunk → embed → Qdrant（复用现有 pipeline）
```

## 约束与风险

### 内存限制

CF Workers 128MB 内存。图片 base64 约为原始大小 × 1.37。10MB 图片：
- ArrayBuffer: 10MB
- base64 字符串: ~14MB
- 总计 ~24MB，加上其他对象仍在安全范围

**解决方案**：`config.upload.maxImageSize` 设为 10MB（非图片仍保持 20MB）。

### CPU 时间

CF Workers paid plan: 30s CPU time（I/O 等待不计）。vision 调用是 I/O 等待，不计入 CPU time。整个 pipeline 中 CPU 密集操作只有 hash/clean/chunk，耗时可控。

### GLM-5V-Turbo 图片限制

API 支持的最大图片大小未公开明确限制，但 base64 请求体通常在 20MB 以内安全。10MB 限制足够覆盖大多数手机拍照和截图场景。

## 改动清单

### 1. config.ts

```ts
vision: {
  model: 'glm-5v-turbo',
  baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', // 同 llm.baseUrl，复用 GLM_API_KEY
},
upload: {
  maxImageSize: 10 * 1024 * 1024, // 图片单独限制 10MB（base64 后 ~14MB）
  // 现有 maxFileSize: 20MB 保持不变
  allowedMimeTypes: [
    // 现有...
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
  ],
  allowedExtensions: [
    // 现有...
    'jpg', 'jpeg', 'png', 'gif', 'webp',
  ],
},
```

### 2. src/llm/client.ts — Message 类型扩展

`Message.content` 从 `string` 扩展为 `string | ContentPart[]`，支持多模态消息：

```ts
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface Message {
  role: string;
  content: string | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
```

新增 `describeImage` 方法（非流式，专门用于图片 OCR）：

```ts
async describeImage(base64DataUrl: string, prompt: string): Promise<string> {
  // 非流式调用 chat/completions
  // messages: [{ role: "user", content: [
  //   { type: "image_url", image_url: { url: base64DataUrl } },
  //   { type: "text", text: prompt }
  // ]}]
  // stream: false
  // 返回 choices[0].message.content
}
```

### 3. src/services/parser.ts

新增图片分支：

- 判断 ext 为 jpg/jpeg/png/gif/webp 时
- 将 buffer 转为 base64 data URL（`data:{mimeType};base64,{base64String}`）
- 调用 `visionClient.describeImage(dataUrl, OCR_PROMPT)`
- 返回提取的文本

`parseFile` 签名变更：

```ts
export async function parseFile(
  buffer: ArrayBuffer,
  mimeType: string,
  filename: string,
  options?: { visionClient?: LLMClient },
): Promise<string>
```

使用 options 对象而非可选参数，便于后续扩展。

OCR prompt:
```
请提取图片中的所有文字内容。如有表格请转为 Markdown 表格，如有数学公式请转为 LaTeX 格式。然后简要描述图片的主要内容。
```

日志：调用前后打印 `log.info('parser:image', 'vision OCR start/end', { filename, size })`。

### 4. src/services/upload.ts

`processFileUpload` 新增 `visionClient` 依赖：

```ts
deps: {
  // 现有...
  visionClient?: LLMClient;
}
```

传给 `parseFile(buffer, file.type, file.name, { visionClient: deps.visionClient })`。

### 5. src/index.ts

upload 路由：

- 对图片类型额外校验 `file.size <= config.upload.maxImageSize`
- 创建 vision LLMClient 并传入 deps：

```ts
const isImage = file.type.startsWith('image/');
const visionClient = isImage ? new LLMClient({
  apiKey: c.env.GLM_API_KEY,
  baseUrl: config.vision.baseUrl,
  model: config.vision.model,
}) : undefined;
```

### 6. 前端

- `index.html`：upload-hint 文案改为 "Supports PDF, DOCX, TXT, MD and images (JPG, PNG)"
- `app.js`：`getFileIcon` 已有 `image/` 分支，无需改动

## 不改动

- `chunker.ts`、`cleaner.ts` — 完全复用
- `dao/` — 完全复用
- `schema.sql` — mime_type 已是 TEXT，无需变更
- `search.ts` — 搜索逻辑不变
- `LLMClient.chat()` — 不改动，新增 `describeImage` 方法独立于 chat

## 错误处理

- 图片超过 10MB → 路由层拦截（400: "Image too large"）
- GLM-5V-Turbo 调用失败 → `parseFile` 抛错 → `processFileUpload` 外层 catch → 返回 500
- 图片无文字内容 → LLM 返回纯描述文本 → 正常入 RAG（语义可搜索）
- 不支持的图片格式（如 BMP/TIFF）→ 扩展名校验拦截（400）

## 测试

1. **parser.test.ts** — 图片 buffer + mock LLMClient → 返回提取文本
2. **parser.test.ts** — 无 visionClient + 图片文件 → 抛错
3. **client.test.ts** — `describeImage` 返回文本（mock fetch）
4. **routes.test.ts** — 上传 JPG 文件 → 200 + 返回 doc
5. **routes.test.ts** — 上传超 10MB 图片 → 400
6. **routes.test.ts** — 上传 .bmp 不在允许列表 → 400
