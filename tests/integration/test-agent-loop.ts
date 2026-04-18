import * as fs from 'fs';

const apiKey = process.env.GLM_API_KEY!;
const baseUrl = 'https://open.bigmodel.cn/api/coding/paas/v4';
const model = 'glm-5-turbo';

const toolsDef = [
  { type: 'function', function: { name: 'task_create', description: 'Create a new task', parameters: { type: 'object', properties: { title: { type: 'string', description: 'Task title' }, description: { type: 'string', description: 'Task description' }, priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Task priority' } }, required: ['title'] } } },
  { type: 'function', function: { name: 'task_list', description: 'List tasks', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'] } } } } },
  { type: 'function', function: { name: 'task_update', description: 'Update task', parameters: { type: 'object', properties: { id: { type: 'number' }, title: { type: 'string' }, description: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'] }, priority: { type: 'string', enum: ['low', 'medium', 'high'] } }, required: ['id'] } } },
  { type: 'function', function: { name: 'task_delete', description: 'Delete task', parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } },
  { type: 'function', function: { name: 'web_fetch', description: 'Fetch URL', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'file_list', description: 'List files', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'file_delete', description: 'Delete file', parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'chunks_search', description: 'Search chunks', parameters: { type: 'object', properties: { query: { type: 'string' }, mode: { type: 'string', enum: ['keyword', 'vector', 'hybrid'] } }, required: ['query'] } } },
];

const systemPrompt = `# 可用工具\n\n你可以使用以下工具：\n${JSON.stringify(toolsDef, null, 2)}\n\n# 基本指令\n\n你是一个智能任务管理助手。\n\n## 核心能力\n- 任务管理：创建、查询、更新、删除任务\n- 网络搜索：搜索互联网获取最新信息\n- 文件管理：管理用户上传的文件和文档\n- 文档检索：从用户上传的文档中检索相关信息\n\n## 行为准则\n- 回复简洁明了，直奔主题\n- 主动使用工具完成任务，不要只是描述如何做\n- 使用用户使用的语言回复\n- 如果信息不足，主动提问或搜索补充\n\n## 深度研究\n对于复杂问题，请按以下步骤处理：\n1. 将问题分解为若干子问题\n2. 逐一搜索每个子问题\n3. 综合所有结果，给出带引用的完整回答\n\n# 用户信息\n\n用户名：测试用户\n\n# 当前时间\n\n${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;

async function callLLM(messages: any[], label: string) {
  const body = { model, messages, stream: true, tools: toolsDef };
  const bodyJson = JSON.stringify(body);
  fs.writeFileSync(`logs/${label}-request.json`, bodyJson);

  console.log(`\n=== ${label} ===`);
  console.log(`Request size: ${bodyJson.length} bytes`);

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: bodyJson,
  });

  console.log(`Status: ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const errorBody = await res.text();
    console.log(`ERROR: ${errorBody}`);
    fs.writeFileSync(`logs/${label}-error.txt`, errorBody);

    // Also dump the messages structure for debugging
    console.log('\nMessages structure:');
    messages.forEach((m: any, i: number) => {
      const info: any = { role: m.role, contentLen: m.content?.length ?? 'null' };
      if (m.tool_calls) info.tool_calls = m.tool_calls.map((tc: any) => ({ id: tc.id, name: tc.function?.name }));
      if (m.tool_call_id) info.tool_call_id = m.tool_call_id;
      console.log(`  [${i}] ${JSON.stringify(info)}`);
    });

    return null;
  }

  const text = await res.text();
  let fullContent = '';
  const toolCalls: any[] = [];

  for (const block of text.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6);
    if (payload === '[DONE]') break;
    try {
      const parsed = JSON.parse(payload);
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.content) fullContent += delta.content;
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCalls.find(t => t.index === tc.index);
          if (!existing) {
            toolCalls.push({ index: tc.index, id: tc.id, name: tc.function?.name, args: tc.function?.arguments || '' });
          } else {
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.args += tc.function.arguments;
          }
        }
      }
    } catch {}
  }

  console.log(`Content: ${fullContent.slice(0, 200) || '(empty)'}`);
  console.log(`Tool calls: ${toolCalls.length}`);
  toolCalls.forEach(tc => console.log(`  - ${tc.name}(${tc.args}) id=${tc.id}`));

  return { content: fullContent, toolCalls };
}

async function main() {
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '帮我创建两个任务：\n1. 下午 1:00 之前记得吃饭\n2. 下午 3:00 的时候出去踢足球' },
  ];

  const round1 = await callLLM(messages, 'round1');
  if (!round1) return;

  if (round1.toolCalls.length === 0) {
    console.log('\nNo tool calls - done');
    return;
  }

  // Build assistant message
  const assistantMsg: any = { role: 'assistant', content: round1.content };
  if (round1.toolCalls.length > 0) {
    assistantMsg.tool_calls = round1.toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.args },
    }));
  }
  messages.push(assistantMsg);

  // Add tool results
  for (const tc of round1.toolCalls) {
    let args: any = {};
    try { args = JSON.parse(tc.args); } catch {}
    const result = { id: Math.floor(Math.random() * 1000), ...args, status: 'pending', priority: args.priority || 'medium' };
    messages.push({
      role: 'tool',
      content: JSON.stringify(result),
      tool_call_id: tc.id,
    });
  }

  const round2 = await callLLM(messages, 'round2');
  if (!round2) return;

  console.log('\n=== FULL TEST PASSED ===');
}

main().catch(e => { console.error(e); process.exit(1); });
