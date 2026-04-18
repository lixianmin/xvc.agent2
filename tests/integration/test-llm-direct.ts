import { LLMClient, type Message } from '../src/llm/client';
import { getToolDefinitions } from '../src/agent/tools';
import { buildSystemPrompt } from '../src/agent/prompt';
import * as fs from 'fs';

async function main() {
  const apiKey = process.env.GLM_API_KEY!;
  const baseUrl = 'https://open.bigmodel.cn/api/coding/paas/v4';
  const model = 'glm-5-turbo';

  const tools = getToolDefinitions();
  const systemPrompt = buildSystemPrompt({
    tools,
    userName: '测试用户',
    datetime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
  });

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '帮我创建两个任务：\n1. 下午 1:00 之前记得吃饭\n2. 下午 3:00 的时候出去踢足球' },
  ];

  const logData = {
    url: `${baseUrl}/chat/completions`,
    model,
    toolCount: tools.length,
    toolNames: tools.map(t => t.function.name),
    systemPromptLen: systemPrompt.length,
    messages: messages.map(m => ({ role: m.role, contentLen: m.content.length })),
    requestBody: {
      model,
      messages,
      stream: true,
      tools,
    },
  };

  fs.writeFileSync('logs/test-llm-request.json', JSON.stringify(logData, null, 2));
  console.log('Request body saved to logs/test-llm-request.json');

  const client = new LLMClient({ apiKey, baseUrl, model });

  console.log('\n--- Calling LLM API ---\n');

  try {
    let fullText = '';
    for await (const event of client.chat(messages, tools)) {
      if (event.type === 'text') {
        process.stdout.write(event.content);
        fullText += event.content;
      } else if (event.type === 'tool_call') {
        console.log(`\n[TOOL_CALL] name=${event.name}, call_id=${event.call_id}, args=${JSON.stringify(event.args)}`);
      }
    }
    console.log('\n\n--- LLM call succeeded ---');
    console.log(`Full text length: ${fullText.length}`);
  } catch (err: any) {
    console.error('\n--- LLM call FAILED ---');
    console.error(`Error: ${err.message}`);
    fs.writeFileSync('logs/test-llm-error.txt', err.message + '\n' + (err.stack || ''));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
