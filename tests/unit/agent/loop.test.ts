import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop, type AgentDeps, type AgentEvent } from '../../../src/agent/loop';
import { runSub } from '../../../src/agent/sub-agent';
import { LLMClient, type ChatEvent } from '../../../src/llm/client';
import { EmbeddingClient } from '../../../src/llm/embedding';
import { QdrantDAO } from '../../../src/dao/qdrant';
import { saveMessage, loadMessages, getUser } from '../../../src/dao/d1';
import { chunksSearch } from '../../../src/services/search';
import { buildSystemPrompt } from '../../../src/agent/prompt';
import { getToolDefinitions, dispatchTool, type ToolDeps } from '../../../src/agent/tools';

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

let mockRunSub: ReturnType<typeof vi.fn>;
vi.mock('../../../src/agent/sub-agent', () => ({
  get SUB_AGENT_PROMPT() { return '## 子代理模式'; },
  runSub: (...args: any[]) => mockRunSub(...args),
}));

async function collectEvents(stream: ReadableStream): Promise<any[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: any[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ') && !line.includes('[DONE]')) {
        events.push(JSON.parse(line.slice(6)));
      }
    }
  }
  return events;
}

async function collectGeneratorEvents(gen: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function makeMockLLM(eventsPerCall: ChatEvent[][]): LLMClient {
  const client = new LLMClient({ apiKey: 'k', baseUrl: 'http://x', model: 'm' });
  let callIdx = 0;
  client.chat = vi.fn().mockImplementation(() => {
    const events = eventsPerCall[callIdx++] ?? [];
    return (async function* () {
      for (const e of events) yield e;
    })();
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

const USER_ID = 1;
const CONV_ID = 10;
const USER_MSG = 'Hello';

describe('AgentLoop', () => {
  let deps: AgentDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    (getUser as any).mockResolvedValue({ id: USER_ID, name: 'TestUser', ai_nickname: '小助' });
    (loadMessages as any).mockResolvedValue([]);
    (saveMessage as any).mockResolvedValue({ id: 1 });
    (chunksSearch as any).mockResolvedValue([]);
  });

  it('streams text response without tools', async () => {
    const llm = makeMockLLM([
      [{ type: 'text', content: 'Hi there.' }],
    ]);
    deps = makeDeps(llm);

    const stream = new AgentLoop(deps).run(USER_ID, CONV_ID, USER_MSG);
    const events = await collectEvents(stream);

    const textEvents = events.filter(e => e.type === 'text');
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
    expect(textEvents.map(e => e.content).join('')).toContain('Hi there.');
  });

  it('dispatches tool calls and injects results back to LLM', async () => {
    const llm = makeMockLLM([
      [{ type: 'tool_call', name: 'web_search', args: { q: 'test' }, call_id: 'c1' }],
      [{ type: 'text', content: 'Done' }],
    ]);
    (dispatchTool as any).mockResolvedValue('{"results":[]}');
    deps = makeDeps(llm);

    const stream = new AgentLoop(deps).run(USER_ID, CONV_ID, USER_MSG);
    const events = await collectEvents(stream);

    expect(events.some(e => e.type === 'tool_call' && e.name === 'web_search')).toBe(true);
    expect(events.some(e => e.type === 'tool_result' && e.call_id === 'c1')).toBe(true);
    expect(events.some(e => e.type === 'text' && e.content === 'Done')).toBe(true);
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it('handles multiple tool calls in one round', async () => {
    const llm = makeMockLLM([
      [
        { type: 'tool_call', name: 'web_search', args: { q: 'a' }, call_id: 'c1' },
        { type: 'tool_call', name: 'web_search', args: { q: 'b' }, call_id: 'c2' },
      ],
      [{ type: 'text', content: 'Both done' }],
    ]);
    (dispatchTool as any).mockResolvedValue('[]');
    deps = makeDeps(llm);

    const stream = new AgentLoop(deps).run(USER_ID, CONV_ID, USER_MSG);
    const events = await collectEvents(stream);

    const toolCallEvents = events.filter(e => e.type === 'tool_call');
    const toolResultEvents = events.filter(e => e.type === 'tool_result');
    expect(toolCallEvents).toHaveLength(2);
    expect(toolResultEvents).toHaveLength(2);
    expect(dispatchTool).toHaveBeenCalledTimes(2);
  });

  it('passes malformed tool args to dispatch without silently swallowing', async () => {
    const llm = makeMockLLM([
      [{ type: 'tool_call', name: 'web_search', args: { _parseError: 'LLM returned invalid JSON' }, call_id: 'c1' }],
      [{ type: 'text', content: 'Recovered' }],
    ]);
    (dispatchTool as any).mockResolvedValue('{"error":"bad args"}');
    deps = makeDeps(llm);

    const stream = new AgentLoop(deps).run(USER_ID, CONV_ID, USER_MSG);
    const events = await collectEvents(stream);

    expect(dispatchTool).toHaveBeenCalledWith('web_search', { _parseError: 'LLM returned invalid JSON' }, expect.anything());
    expect(events.some(e => e.type === 'tool_result')).toBe(true);
  });

  it('stops after 30 rounds with limit_reached', async () => {
    const toolEvent: ChatEvent = { type: 'tool_call', name: 'web_search', args: { q: 'x' }, call_id: 'c0' };
    const rounds: ChatEvent[][] = [];
    for (let i = 0; i < 31; i++) {
      rounds.push([toolEvent]);
    }
    const llm = makeMockLLM(rounds);
    (dispatchTool as any).mockResolvedValue('[]');
    deps = makeDeps(llm);

    const stream = new AgentLoop(deps).run(USER_ID, CONV_ID, USER_MSG);
    const events = await collectEvents(stream);

    expect(events.some(e => e.type === 'limit_reached')).toBe(true);
    expect(llm.chat.mock.calls.length).toBeLessThanOrEqual(31);
  });

  it('performs RAG pre-retrieval before first LLM call', async () => {
    const llm = makeMockLLM([
      [{ type: 'text', content: 'ok' }],
    ]);
    deps = makeDeps(llm);

    const stream = new AgentLoop(deps).run(USER_ID, CONV_ID, USER_MSG);
    await collectEvents(stream);

    expect(chunksSearch).toHaveBeenCalledWith(USER_MSG, USER_ID, 'hybrid', expect.objectContaining({
      d1: deps.d1,
      qdrant: deps.qdrant,
      embedding: deps.embedding,
    }));
    expect(buildSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
      ragContext: '',
    }));
  });

  it('persists messages to DB', async () => {
    const llm = makeMockLLM([
      [
        { type: 'text', content: 'ans' },
        { type: 'tool_call', name: 'task_create', args: { title: 'T' }, call_id: 'c1' },
      ],
      [{ type: 'text', content: 'final' }],
    ]);
    (dispatchTool as any).mockResolvedValue('{"id":1}');
    deps = makeDeps(llm);

    const stream = new AgentLoop(deps).run(USER_ID, CONV_ID, USER_MSG);
    await collectEvents(stream);

    const saveCalls = (saveMessage as any).mock.calls;
    const roles = saveCalls.map((c: any[]) => c[1].role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    expect(roles).toContain('tool');
  });

  it('handles LLM API failure with error event', async () => {
    const llm = makeMockLLM([]);
    llm.chat = vi.fn().mockImplementation(() => {
      throw new Error('LLM API error: 500 Internal Error');
    });
    deps = makeDeps(llm);

    const stream = new AgentLoop(deps).run(USER_ID, CONV_ID, USER_MSG);
    const events = await collectEvents(stream);

    expect(events.some(e => e.type === 'error')).toBe(true);
  });

  it('sends status events', async () => {
    const llm = makeMockLLM([
      [{ type: 'text', content: 'hi' }],
    ]);
    deps = makeDeps(llm);

    const stream = new AgentLoop(deps).run(USER_ID, CONV_ID, USER_MSG);
    const events = await collectEvents(stream);

    const statusEvents = events.filter(e => e.type === 'status');
    const statusContents = statusEvents.map(e => e.content);
    expect(statusContents).toContain('正在检索相关文档...');
    expect(statusContents).toContain('正在思考...');
  });

  it('sends [DONE] at the end', async () => {
    const llm = makeMockLLM([
      [{ type: 'text', content: 'bye' }],
    ]);
    deps = makeDeps(llm);

    const stream = new AgentLoop(deps).run(USER_ID, CONV_ID, USER_MSG);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullText += decoder.decode(value);
    }

    expect(fullText).toContain('data: [DONE]\n\n');
  });
});

describe('AgentLoop execute() generator', () => {
  let deps: AgentDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    (getUser as any).mockResolvedValue({ id: USER_ID, name: 'TestUser', ai_nickname: '小助' });
    (loadMessages as any).mockResolvedValue([]);
    (saveMessage as any).mockResolvedValue({ id: 1 });
    (chunksSearch as any).mockResolvedValue([]);
    mockRunSub = vi.fn().mockResolvedValue('mock sub result');
  });

  it('execute() yields events as async generator', async () => {
    const llm = makeMockLLM([
      [{ type: 'text', content: 'Hello from generator.' }],
    ]);
    deps = makeDeps(llm);

    const gen = new AgentLoop(deps).execute(USER_ID, CONV_ID, USER_MSG);
    const events = await collectGeneratorEvents(gen);

    const textEvents = events.filter(e => e.type === 'text');
    expect(textEvents.map(e => e.content).join('')).toContain('Hello from generator.');
    expect(events.some(e => e.type === 'status')).toBe(true);
  });

  it('execute() with persistMessages=false skips DB writes but includes user message in LLM call', async () => {
    const llm = makeMockLLM([
      [{ type: 'text', content: 'ok' }],
    ]);
    deps = makeDeps(llm);

    const gen = new AgentLoop(deps, 'sub-0').execute(USER_ID, CONV_ID, USER_MSG, {
      persistMessages: false,
    });
    const events = await collectGeneratorEvents(gen);

    expect(saveMessage).not.toHaveBeenCalled();
    expect(loadMessages).not.toHaveBeenCalled();
    expect(events.some(e => e.type === 'text')).toBe(true);

    const llmCallArgs = (llm.chat as any).mock.calls[0];
    const messages = llmCallArgs[0];
    const roles = messages.map((m: any) => m.role);
    expect(roles).toContain('user');
    expect(messages.find((m: any) => m.role === 'user')?.content).toBe(USER_MSG);
  });

  it('execute() with skipRag=true skips RAG retrieval', async () => {
    const llm = makeMockLLM([
      [{ type: 'text', content: 'ok' }],
    ]);
    deps = makeDeps(llm);

    const gen = new AgentLoop(deps, 'sub-0').execute(USER_ID, CONV_ID, USER_MSG, {
      skipRag: true,
    });
    const events = await collectGeneratorEvents(gen);

    expect(chunksSearch).not.toHaveBeenCalled();
    expect(events.filter(e => e.type === 'status' && e.content.includes('检索'))).toHaveLength(0);
  });

  it('execute() with custom tools uses provided tool set', async () => {
    const customTools = [{ type: 'function' as const, function: { name: 'my_tool', description: 'test', parameters: { type: 'object', properties: {} } } }];
    const llm = makeMockLLM([
      [{ type: 'text', content: 'ok' }],
    ]);
    deps = makeDeps(llm);

    const gen = new AgentLoop(deps, 'sub-0').execute(USER_ID, CONV_ID, USER_MSG, {
      tools: customTools,
    });
    await collectGeneratorEvents(gen);

    expect(llm.chat).toHaveBeenCalledWith(
      expect.anything(),
      customTools,
    );
  });

  it('execute() yields limit_reached when max rounds exceeded', async () => {
    const toolEvent: ChatEvent = { type: 'tool_call', name: 'web_search', args: { q: 'x' }, call_id: 'c0' };
    const rounds: ChatEvent[][] = [];
    for (let i = 0; i < 6; i++) {
      rounds.push([toolEvent]);
    }
    const llm = makeMockLLM(rounds);
    (dispatchTool as any).mockResolvedValue('[]');
    deps = makeDeps(llm);

    const gen = new AgentLoop(deps).execute(USER_ID, CONV_ID, USER_MSG, {
      maxRounds: 5,
    });
    const events = await collectGeneratorEvents(gen);

    expect(events.some(e => e.type === 'limit_reached')).toBe(true);
  });

  it('spawn_agent in runLoop dispatches sub-agents and yields results', async () => {
    let callIdx = 0;
    const responses: ChatEvent[][] = [
      [{ type: 'tool_call', name: 'spawn_agent', args: { tasks: ['task A', 'task B'] }, call_id: 'sa-1' }],
      [{ type: 'text', content: 'Final synthesis' }],
    ];

    const llm = makeMockLLM([]);
    llm.chat = vi.fn().mockImplementation(() => {
      const events = responses[callIdx++] ?? [];
      return (async function* () { for (const e of events) yield e; })();
    });

    mockRunSub.mockImplementation((_deps: any, agentId: string, _userId: number, task: string) => {
      return Promise.resolve(`Sub result for ${task} [${agentId}]`);
    });

    deps = makeDeps(llm);
    const gen = new AgentLoop(deps).execute(USER_ID, CONV_ID, USER_MSG);
    const events = await collectGeneratorEvents(gen);

    expect(mockRunSub).toHaveBeenCalledTimes(2);
    expect(mockRunSub).toHaveBeenCalledWith(deps, 'sub-0', USER_ID, 'task A', undefined);
    expect(mockRunSub).toHaveBeenCalledWith(deps, 'sub-1', USER_ID, 'task B', undefined);

    const toolResults = events.filter(e => e.type === 'tool_result' && e.name === 'spawn_agent');
    expect(toolResults).toHaveLength(1);
    const result = JSON.parse(toolResults[0].result);
    expect(result).toHaveLength(2);
    expect(result[0].task).toBe('task A');
    expect(result[0].result).toContain('Sub result for task A');
    expect(result[1].task).toBe('task B');

    const statusEvents = events.filter(e => e.type === 'status');
    expect(statusEvents.some(s => s.content.includes('子代理'))).toBe(true);
  });

  it('spawn_agent in runLoop dispatches sub-agents and yields results', async () => {
    let callIdx = 0;
    const responses: ChatEvent[][] = [
      [{ type: 'tool_call', name: 'spawn_agent', args: { tasks: ['task A', 'task B'] }, call_id: 'sa-1' }],
      [{ type: 'text', content: 'Final synthesis' }],
    ];
    const subResponses: ChatEvent[][] = [
      [{ type: 'text', content: 'Result A' }],
      [{ type: 'text', content: 'Result B' }],
    ];
    let subIdx = 0;

    const llm = makeMockLLM([]);
    llm.chat = vi.fn().mockImplementation(() => {
      if (callIdx === 0) {
        const events = responses[callIdx++];
        return (async function* () { for (const e of events) yield e; })();
      }
      const events = responses[callIdx++] ?? [];
      return (async function* () { for (const e of events) yield e; })();
    });

    const origRunSub = runSub.bind(AgentLoop);
    runSub = vi.fn().mockImplementation((_deps: any, agentId: string, _userId: number, task: string) => {
      return Promise.resolve(`Sub result for ${task} [${agentId}]`);
    });

    try {
      deps = makeDeps(llm);
      const gen = new AgentLoop(deps).execute(USER_ID, CONV_ID, USER_MSG);
      const events = await collectGeneratorEvents(gen);

      expect(runSub).toHaveBeenCalledTimes(2);
      expect(runSub).toHaveBeenCalledWith(deps, 'sub-0', USER_ID, 'task A', undefined);
      expect(runSub).toHaveBeenCalledWith(deps, 'sub-1', USER_ID, 'task B', undefined);

      const toolResults = events.filter(e => e.type === 'tool_result' && e.name === 'spawn_agent');
      expect(toolResults).toHaveLength(1);
      const result = JSON.parse(toolResults[0].result);
      expect(result).toHaveLength(2);
      expect(result[0].task).toBe('task A');
      expect(result[0].result).toContain('Sub result for task A');
      expect(result[1].task).toBe('task B');

      const statusEvents = events.filter(e => e.type === 'status');
      expect(statusEvents.some(s => s.content.includes('子代理'))).toBe(true);
    } finally {
      runSub = origRunSub;
    }
  });
});
