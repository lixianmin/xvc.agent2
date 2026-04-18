import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSub } from '../../../src/agent/sub-agent';
import { AgentLoop, type AgentDeps } from '../../../src/agent/loop';
import { LLMClient } from '../../../src/llm/client';

vi.mock('../../../src/dao/d1', () => ({
  saveMessage: vi.fn(),
  loadMessages: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock('../../../src/services/search', () => ({
  chunksSearch: vi.fn(),
}));

vi.mock('../../../src/agent/prompt', () => ({
  buildSystemPrompt: vi.fn().mockReturnValue('system-prompt-mock'),
}));

vi.mock('../../../src/agent/tools', () => ({
  getToolDefinitions: vi.fn().mockReturnValue([{ type: 'function', function: { name: 'test_tool', description: 'test', parameters: { type: 'object', properties: {} } } }]),
  getSubAgentToolDefinitions: vi.fn().mockReturnValue([{ type: 'function', function: { name: 'test_tool', description: 'test', parameters: { type: 'object', properties: {} } } }]),
  dispatchTool: vi.fn(),
}));

import { getUser } from '../../../src/dao/d1';

const USER_ID = 1;

function makeMockLLM(eventsPerCall: any[][]): LLMClient {
  const client = new LLMClient({ apiKey: 'k', baseUrl: 'http://x', model: 'm' });
  let callIdx = 0;
  client.chat = vi.fn().mockImplementation(() => {
    const events = eventsPerCall[callIdx++] ?? [];
    return (async function* () { for (const e of events) yield e; })();
  });
  return client;
}

function makeDeps(llm: LLMClient): AgentDeps {
  return {
    d1: { prepare: vi.fn().mockReturnThis(), bind: vi.fn().mockReturnThis(), run: vi.fn(), first: vi.fn(), all: vi.fn() } as any,
    llm,
    embedding: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) } as any,
    qdrant: { searchVectors: vi.fn().mockResolvedValue([]) } as any,
    serperApiKey: 'serper-key',
  };
}

describe('runSub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getUser as any).mockResolvedValue({ id: USER_ID, name: 'TestUser' });
  });

  it('returns text from sub-agent execution', async () => {
    const llm = makeMockLLM([[{ type: 'text', content: 'Research result.' }]]);
    const deps = makeDeps(llm);
    const result = await runSub(deps, 'sub-0', USER_ID, 'search for X');
    expect(result).toBe('Research result.');
  });

  it('returns fallback when sub-agent produces no text', async () => {
    const llm = makeMockLLM([[]]);
    const deps = makeDeps(llm);
    const result = await runSub(deps, 'sub-0', USER_ID, 'search');
    expect(result).toBe('[子代理无输出]');
  });

  it('returns timeout when no events for 10s', async () => {
    const llm = makeMockLLM([]);
    llm.chat = vi.fn().mockImplementation(() => {
      return (async function* () { await new Promise(() => {}); })();
    });
    const deps = makeDeps(llm);
    const result = await runSub(deps, 'sub-0', USER_ID, 'task');
    expect(result).toBe('[子代理执行超时]');
  }, 15_000);

  it('returns error message on LLM failure', async () => {
    const llm = makeMockLLM([]);
    llm.chat = vi.fn().mockImplementation(() => { throw new Error('LLM boom'); });
    const deps = makeDeps(llm);
    const result = await runSub(deps, 'sub-0', USER_ID, 'task');
    expect(result).toBe('[子代理执行失败: LLM boom]');
  });

  it('passes context to user message when provided', async () => {
    let capturedMsgs: any = null;
    const llm = makeMockLLM([[{ type: 'text', content: 'ok' }]]);
    llm.chat = vi.fn().mockImplementation((msgs: any) => {
      capturedMsgs = msgs;
      return (async function* () { yield { type: 'text', content: 'ok' }; })();
    });
    const deps = makeDeps(llm);
    await runSub(deps, 'sub-0', USER_ID, 'the task', 'background info');

    const userMsg = capturedMsgs.find((m: any) => m.role === 'user');
    expect(userMsg.content).toContain('背景信息：background info');
    expect(userMsg.content).toContain('任务：the task');
  });

  it('uses sub-agent agentId in new AgentLoop instance', async () => {
    const llm = makeMockLLM([[{ type: 'text', content: 'ok' }]]);
    const deps = makeDeps(llm);
    await runSub(deps, 'sub-42', USER_ID, 'task');
  });
});
