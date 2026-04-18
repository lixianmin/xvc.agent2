# P5: Image Multimodal Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add image upload support with GLM-5V-Turbo OCR → text extraction → existing RAG pipeline.

**Architecture:** Extend `LLMClient` with a `describeImage` method (non-streaming) and `Message.content` to support multimodal arrays. Extend `parser.ts` to handle image types. The rest of the pipeline (clean → chunk → embed → Qdrant) is fully reused.

**Tech Stack:** GLM-5V-Turbo vision API (OpenAI-compatible), existing Vitest + cloudflare:test

**Spec:** `docs/superpowers/specs/2025-04-18-image-multimodal-design.md`

---

## Chunk 1: Config + LLMClient

### Task 1: Add vision config + image upload types

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add vision config block and image upload types**

```ts
  llm: {
    model: 'glm-5-turbo',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
  },
  vision: {
    model: 'glm-5v-turbo',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
  },
  embedding: {
    // ...
  },
  // ... in upload section:
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
```

- [ ] **Step 2: Run existing tests to verify no breakage**

Run: `npx vitest run tests/unit/services/parser.test.ts`
Expected: All pass (config change doesn't affect parser logic yet)

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(P5): add vision config and image upload types"
```

### Task 2: Extend Message type + add describeImage to LLMClient

**Files:**
- Modify: `src/llm/client.ts`
- Modify: `tests/unit/llm/client.test.ts`

- [ ] **Step 1: Write failing test for describeImage**

Add to `tests/unit/llm/client.test.ts`:

```ts
  it('describeImage returns text from vision API', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '图片中的文字：你好世界' } }],
      }),
    });

    const result = await client.describeImage('data:image/png;base64,abc123', '请提取文字');
    expect(result).toBe('图片中的文字：你好世界');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.stream).toBe(false);
    expect(callBody.model).toBe('test-model');
    const content = callBody.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe('image_url');
    expect(content[1].type).toBe('text');
  });

  it('describeImage throws on API error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Error' });
    await expect(client.describeImage('data:image/png;base64,abc', 'prompt')).rejects.toThrow();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/llm/client.test.ts`
Expected: FAIL — `client.describeImage is not a function`

- [ ] **Step 3: Add ContentPart type + describeImage method**

In `src/llm/client.ts`, add before `Message` interface:

```ts
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
```

Change `Message.content`:

```ts
export interface Message {
  role: string;
  content: string | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
```

Add `describeImage` method to `LLMClient` class (after `chat` method):

```ts
  async describeImage(base64DataUrl: string, prompt: string): Promise<string> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        stream: false,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: base64DataUrl } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    if (!res.ok) throw new Error(`Vision API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as { choices: { message: { content: string } }[] };
    return data.choices[0].message.content;
  }
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run tests/unit/llm/client.test.ts`
Expected: All pass (7 existing + 2 new = 9)

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/llm/client.ts tests/unit/llm/client.test.ts
git commit -m "feat(P5): add ContentPart type + describeImage method to LLMClient"
```

---

## Chunk 2: Parser + Upload Pipeline

### Task 3: Add image parsing to parser.ts

**Files:**
- Modify: `src/services/parser.ts`
- Modify: `tests/unit/services/parser.test.ts`

- [ ] **Step 1: Write failing test for image parsing**

Add to `tests/unit/services/parser.test.ts` (inside top-level `describe('parseFile', ...)`):

```ts
  describe('Image parsing', () => {
    it('calls visionClient.describeImage for image files', async () => {
      const mockClient = {
        describeImage: vi.fn().mockResolvedValue('OCR text from image'),
      } as any;

      vi.resetModules();
      const { parseFile } = await import('../../../src/services/parser');
      const buffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

      const result = await parseFile(buffer, 'image/png', 'photo.png', { visionClient: mockClient });
      expect(result).toBe('OCR text from image');
      expect(mockClient.describeImage).toHaveBeenCalledTimes(1);
      expect(mockClient.describeImage.mock.calls[0][0]).toContain('data:image/png;base64,');
    });

    it('throws if image file has no visionClient', async () => {
      vi.resetModules();
      const { parseFile } = await import('../../../src/services/parser');
      const buffer = new ArrayBuffer(4);
      await expect(parseFile(buffer, 'image/png', 'photo.png')).rejects.toThrow(/vision/i);
    });
  });
```

Note: The existing test `it('throws error for unsupported file extension', ...)` at line 41 sends `photo.png` and expects "unsupported" — this test will need to be updated since png is now a supported image type. Change it to use `.bmp` instead:

```ts
  it('throws error for unsupported file extension', async () => {
    const parseFile = await getParseFile();
    const buffer = new ArrayBuffer(0);
    await expect(parseFile(buffer, 'image/bmp', 'photo.bmp')).rejects.toThrow(
      /unsupported/i,
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/services/parser.test.ts`
Expected: FAIL — image tests fail (no image handling in parser yet)

- [ ] **Step 3: Implement image parsing in parser.ts**

Add import at top:

```ts
import type { LLMClient } from '../llm/client';
import { log } from './logger';
```

Change function signature:

```ts
export async function parseFile(
  buffer: ArrayBuffer,
  mimeType: string,
  filename: string,
  options?: { visionClient?: LLMClient },
): Promise<string> {
```

Add image branch before the final `throw`:

```ts
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
  if (imageExts.includes(ext)) {
    if (!options?.visionClient) {
      throw new Error(`Image parsing requires a vision client: ${filename}`);
    }
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    const dataUrl = `data:${mimeType};base64,${base64}`;
    log.info('parser:image', 'vision OCR start', { filename, size: buffer.byteLength });
    const text = await options.visionClient.describeImage(dataUrl,
      '请提取图片中的所有文字内容。如有表格请转为 Markdown 表格，如有数学公式请转为 LaTeX 格式。然后简要描述图片的主要内容。',
    );
    log.info('parser:image', 'vision OCR end', { filename });
    return text;
  }
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run tests/unit/services/parser.test.ts`
Expected: All pass

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/services/parser.ts tests/unit/services/parser.test.ts
git commit -m "feat(P5): add image OCR parsing to parser.ts"
```

### Task 4: Wire visionClient into upload pipeline

**Files:**
- Modify: `src/services/upload.ts`

- [ ] **Step 1: Update processFileUpload deps and parseFile call**

In `src/services/upload.ts`, add import:

```ts
import type { LLMClient } from '../llm/client';
```

Update `deps` type:

```ts
  deps: {
    r2: R2Bucket;
    d1: D1Database;
    qdrant: QdrantDAO;
    embedding: EmbeddingClient;
    userId: number;
    visionClient?: LLMClient;
  },
```

Update `parseFile` call:

```ts
  const rawText = await parseFile(buffer, file.type, file.name, { visionClient: deps.visionClient });
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All pass (upload.ts is not directly unit-tested; route tests mock processFileUpload)

- [ ] **Step 3: Commit**

```bash
git add src/services/upload.ts
git commit -m "feat(P5): wire visionClient into upload pipeline"
```

---

## Chunk 3: Routes + Frontend

### Task 5: Add image size validation + vision client in upload route

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/unit/routes.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/unit/routes.test.ts` (inside `describe('POST /api/files/upload', ...)` block):

```ts
  it('rejects image exceeding 10MB limit', async () => {
    const db = env.DB as D1Database;
    const user = await createUser(db, { email: `bigimg${Date.now()}@test.com`, name: 'BigImg' });
    const bigContent = new Uint8Array(11 * 1024 * 1024);
    const formData = new FormData();
    formData.append('file', new File([bigContent], 'big.jpg', { type: 'image/jpeg' }));

    const res = await app.request('/api/files/upload', {
      method: 'POST',
      headers: { 'X-User-Id': String(user.id) },
      body: formData,
    }, testEnv());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Image too large');
  });

  it('rejects unsupported image format bmp', async () => {
    const db = env.DB as D1Database;
    const user = await createUser(db, { email: `bmp${Date.now()}@test.com`, name: 'BmpUser' });
    const formData = new FormData();
    formData.append('file', new File(['data'], 'photo.bmp', { type: 'image/bmp' }));

    const res = await app.request('/api/files/upload', {
      method: 'POST',
      headers: { 'X-User-Id': String(user.id) },
      body: formData,
    }, testEnv());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Unsupported');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/routes.test.ts`
Expected: FAIL — no image size check yet

- [ ] **Step 3: Implement in src/index.ts**

Add `LLMClient` import:

```ts
import { LLMClient } from './llm/client';
```

In the upload route handler, after the existing extension + size validation, add image-specific validation and vision client:

```ts
    const isImage = file.type.startsWith('image/');
    if (isImage && file.size > config.upload.maxImageSize) {
      return c.json({ error: `Image too large: ${file.size} bytes (max ${config.upload.maxImageSize})` }, 400);
    }
```

And pass visionClient to processFileUpload deps:

```ts
    const visionClient = isImage ? new LLMClient({
      apiKey: c.env.GLM_API_KEY,
      baseUrl: config.vision.baseUrl,
      model: config.vision.model,
    }) : undefined;

    const doc = await processFileUpload({
```

Add `visionClient` to the deps object passed to `processFileUpload`.

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/unit/routes.test.ts
git commit -m "feat(P5): add image size validation + vision client in upload route"
```

### Task 6: Update frontend hint text

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Update upload hint text**

Change in `public/index.html`:

```
Supports PDF, DOCX, TXT and more
```
→
```
Supports PDF, DOCX, TXT, MD and images (JPG, PNG)
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat(P5): update frontend hint to mention image support"
```

---

## Chunk 4: Final verification

### Task 7: Run full test suite + update docs

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All pass (194 existing + ~4 new ≈ 198)

- [ ] **Step 2: Update requirements-tracking.md**

- P5 row: `~~多模态支持~~ ✅ 完成` — 加分项 3.1
- 3.1 row: `✅ 完成 | 图片上传 + GLM-5V-Turbo OCR → 文本入 RAG`

- [ ] **Step 3: Update 01.memory.md**

- Test count
- Add `src/llm/client.ts` note about `describeImage` + `ContentPart` type

- [ ] **Step 4: Final commit**

```bash
git add docs/03.requirements-tracking.md docs/01.memory.md
git commit -m "docs: update tracking for P5 multimodal completion"
```
