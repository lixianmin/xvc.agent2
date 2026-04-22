import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../../src/agent/prompt';
import type { ToolDef } from '../../../src/agent/tools';

const sampleTools: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a new task',
      parameters: { type: 'object', properties: { title: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Search the web',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  },
];

describe('buildSystemPrompt', () => {
  it('assembles prompt in correct section order', () => {
    const result = buildSystemPrompt({
      tools: sampleTools,
      userName: 'Alice',
      aiNickname: '小助',
      ragContext: 'Some doc content here',
      datetime: '2025-04-17 14:30:00 CST',
    });

    const toolsIdx = result.indexOf('可用工具');
    const baseIdx = result.indexOf('你是一个智能任务管理助手');
    const userIdx = result.indexOf('Alice');
    const ragIdx = result.indexOf('相关文档');
    const dtIdx = result.indexOf('2025-04-17 14:30:00 CST');

    expect(toolsIdx).toBeGreaterThan(-1);
    expect(baseIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(-1);
    expect(ragIdx).toBeGreaterThan(-1);
    expect(dtIdx).toBeGreaterThan(-1);

    expect(toolsIdx).toBeLessThan(baseIdx);
    expect(baseIdx).toBeLessThan(userIdx);
    expect(userIdx).toBeLessThan(ragIdx);
    expect(ragIdx).toBeLessThan(dtIdx);
  });

  it('omits RAG context when undefined', () => {
    const result = buildSystemPrompt({
      tools: sampleTools,
      userName: 'Alice',
      datetime: '2025-04-17 14:30:00 CST',
    });

    expect(result).not.toContain('相关文档');
    expect(result).not.toContain('检索到的相关内容');
  });

  it('omits RAG context when empty string', () => {
    const result = buildSystemPrompt({
      tools: sampleTools,
      userName: 'Alice',
      ragContext: '',
      datetime: '2025-04-17 14:30:00 CST',
    });

    expect(result).not.toContain('相关文档');
  });

  it('includes all tool schemas as JSON', () => {
    const result = buildSystemPrompt({
      tools: sampleTools,
      userName: 'Alice',
      datetime: '2025-04-17 14:30:00 CST',
    });

    for (const tool of sampleTools) {
      expect(result).toContain(tool.function.name);
      expect(result).toContain(tool.function.description);
    }
    expect(result).toContain('create_task');
    expect(result).toContain('search_web');
  });

  it('includes user name and optional AI nickname', () => {
    const withNickname = buildSystemPrompt({
      tools: sampleTools,
      userName: 'Bob',
      aiNickname: '小智',
      datetime: '2025-04-17 14:30:00 CST',
    });

    expect(withNickname).toContain('Bob');
    expect(withNickname).toContain('小智');

    const withoutNickname = buildSystemPrompt({
      tools: sampleTools,
      userName: 'Carol',
      datetime: '2025-04-17 14:30:00 CST',
    });

    expect(withoutNickname).toContain('Carol');
  });

  it('includes current datetime', () => {
    const result = buildSystemPrompt({
      tools: sampleTools,
      userName: 'Alice',
      datetime: '2025-04-17 14:30:00 CST',
    });

    expect(result).toContain('2025-04-17 14:30:00 CST');
  });

  it('includes role and capability descriptions', () => {
    const result = buildSystemPrompt({
      tools: sampleTools,
      userName: 'Alice',
      datetime: '2025-04-17 14:30:00 CST',
    });

    expect(result).toContain('智能任务管理助手');
    expect(result).toContain('搜索');
  });

  it('includes deep research guidance', () => {
    const result = buildSystemPrompt({
      tools: sampleTools,
      userName: 'Alice',
      datetime: '2025-04-17 14:30:00 CST',
    });

    expect(result).toContain('分解');
  });

  it('appends systemPromptExtra when provided', () => {
    const result = buildSystemPrompt({
      tools: sampleTools,
      userName: 'Test',
      datetime: '2025-04-17',
      systemPromptExtra: '## 子代理模式\n\n你是一个子代理。',
    });
    expect(result).toContain('子代理模式');
    expect(result).toContain('你是一个子代理');
  });

  it('works without systemPromptExtra', () => {
    const result = buildSystemPrompt({
      tools: sampleTools,
      userName: 'Test',
      datetime: '2025-04-17',
    });
    expect(result).toContain('可用工具');
    expect(result).toContain('Test');
  });
});

describe('ragConfidence guidance', () => {
    it('injects high-confidence guidance when ragConfidence is high', () => {
        const result = buildSystemPrompt({
            tools: sampleTools,
            userName: 'Alice',
            ragContext: 'doc content here',
            ragConfidence: 'high',
            datetime: '2025-04-17 14:30:00 CST',
        });

        expect(result).toContain('已从文档中检索到高质量匹配结果');
        expect(result).toContain('无需使用 web_search');
        expect(result).not.toContain('建议使用 web_search 补充');
    });

    it('injects low-confidence guidance when ragConfidence is low', () => {
        const result = buildSystemPrompt({
            tools: sampleTools,
            userName: 'Alice',
            ragContext: 'weak doc content',
            ragConfidence: 'low',
            datetime: '2025-04-17 14:30:00 CST',
        });

        expect(result).toContain('文档匹配度较低');
        expect(result).toContain('建议使用 web_search 补充');
        expect(result).not.toContain('无需使用 web_search');
    });

    it('omits guidance when ragConfidence is none', () => {
        const result = buildSystemPrompt({
            tools: sampleTools,
            userName: 'Alice',
            ragContext: '',
            ragConfidence: 'none',
            datetime: '2025-04-17 14:30:00 CST',
        });

        expect(result).not.toContain('已从文档中检索到高质量匹配结果');
        expect(result).not.toContain('建议使用 web_search 补充');
    });

    it('omits guidance when ragConfidence is undefined', () => {
        const result = buildSystemPrompt({
            tools: sampleTools,
            userName: 'Alice',
            ragContext: 'some content',
            datetime: '2025-04-17 14:30:00 CST',
        });

        expect(result).not.toContain('已从文档中检索到高质量匹配结果');
        expect(result).not.toContain('建议使用 web_search 补充');
    });

    it('places guidance after RAG section and before systemPromptExtra', () => {
        const result = buildSystemPrompt({
            tools: sampleTools,
            userName: 'Alice',
            ragContext: 'doc content',
            ragConfidence: 'high',
            datetime: '2025-04-17 14:30:00 CST',
            systemPromptExtra: '## Extra section',
        });

        const ragIdx = result.indexOf('相关文档');
        const guidanceIdx = result.indexOf('已从文档中检索到高质量匹配结果');
        const extraIdx = result.indexOf('Extra section');

        expect(guidanceIdx).toBeGreaterThan(ragIdx);
        expect(extraIdx).toBeGreaterThan(guidanceIdx);
    });
});
