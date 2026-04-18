import { AgentLoop, type AgentDeps } from './loop';
import { getSubAgentToolDefinitions } from './tools';

export const SUB_AGENT_PROMPT = `## 子代理模式

你是一个子代理，负责完成主代理委派给你的特定任务。
- 直接执行任务，输出结果，不需要寒暄或过渡语
- 任务描述就是你的输入，完成后输出完整的执行结果
- 你可以调用工具（搜索、文件检索等）来完成任务`;

export async function runSub(
  deps: AgentDeps,
  agentId: string,
  userId: number,
  task: string,
  context?: string,
): Promise<string> {
  const HEARTBEAT_MS = 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortReject: ((err: Error) => void) | undefined;

  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortReject = reject;
    timer = setTimeout(() => {
      reject(new Error('heartbeat_timeout'));
    }, HEARTBEAT_MS);
  });

  const refresh = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      abortReject?.(new Error('heartbeat_timeout'));
    }, HEARTBEAT_MS);
  };

  const subLoop = new AgentLoop(deps, agentId);
  try {
    let result = '';
    const userMessage = context ? `背景信息：${context}\n\n任务：${task}` : task;
    const gen = subLoop.execute(userId, 0, userMessage, {
      maxRounds: 15,
      persistMessages: false,
      tools: getSubAgentToolDefinitions(),
      systemPromptExtra: SUB_AGENT_PROMPT,
      skipRag: true,
    });

    while (true) {
      const next = Promise.race([gen.next(), abortPromise]);
      const { done, value } = await next;
      if (done) break;
      refresh();
      if (value.type === 'text') result += value.content;
    }

    if (timer) clearTimeout(timer);
    return result || '[子代理无输出]';
  } catch (err: any) {
    if (timer) clearTimeout(timer);
    if (err.message === 'heartbeat_timeout') return '[子代理执行超时]';
    return `[子代理执行失败: ${err.message}]`;
  }
}
