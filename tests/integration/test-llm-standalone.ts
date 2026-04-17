import * as fs from 'fs';

function getToolDefinitions() {
  return [
    { type: 'function', function: { name: 'task_create', description: 'Create a new task', parameters: { type: 'object', properties: { title: { type: 'string', description: 'Task title' }, description: { type: 'string', description: 'Task description' }, priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Task priority' } }, required: ['title'] } } },
    { type: 'function', function: { name: 'task_list', description: 'List tasks for the current user', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'], description: 'Filter by status' }, limit: { type: 'number', description: 'Maximum number of tasks to return' } } } } },
    { type: 'function', function: { name: 'task_update', description: 'Update an existing task', parameters: { type: 'object', properties: { id: { type: 'number', description: 'Task ID' }, title: { type: 'string', description: 'New title' }, description: { type: 'string', description: 'New description' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'], description: 'New status' }, priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'New priority' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'task_delete', description: 'Delete a task', parameters: { type: 'object', properties: { id: { type: 'number', description: 'Task ID' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'web_search', description: 'Search the web using Google', parameters: { type: 'object', properties: { q: { type: 'string', description: 'Search query' } }, required: ['q'] } } },
    { type: 'function', function: { name: 'web_fetch', description: 'Fetch and extract text content from a URL', parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL to fetch' } }, required: ['url'] } } },
    { type: 'function', function: { name: 'file_list', description: 'List uploaded documents for the current user', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'file_delete', description: 'Delete an uploaded document and its chunks', parameters: { type: 'object', properties: { id: { type: 'number', description: 'Document ID' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'chunks_search', description: 'Search document chunks using keyword, vector, or hybrid mode', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' }, mode: { type: 'string', enum: ['keyword', 'vector', 'hybrid'], description: 'Search mode (default: hybrid)' } }, required: ['query'] } } },
  ];
}

async function main() {
  const apiKey = process.env.GLM_API_KEY!;
  const baseUrl = 'https://open.bigmodel.cn/api/coding/paas/v4';
  const model = 'GLM-5';

  const tools = getToolDefinitions();
  const systemPrompt = `# 可用工具\n\n你可以使用以下工具：\n${JSON.stringify(tools, null, 2)}\n\n# 基本指令\n\n你是一个智能任务管理助手。\n\n## 核心能力\n- 任务管理：创建、查询、更新、删除任务\n- 网络搜索：搜索互联网获取最新信息\n- 文件管理：管理用户上传的文件和文档\n- 文档检索：从用户上传的文档中检索相关信息\n\n## 行为准则\n- 回复简洁明了，直奔主题\n- 主动使用工具完成任务，不要只是描述如何做\n- 使用用户使用的语言回复\n\n# 用户信息\n\n用户名：测试用户\n\n# 当前时间\n\n${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '帮我创建两个任务：\n1. 下午 1:00 之前记得吃饭\n2. 下午 3:00 的时候出去踢足球' },
  ];

  const requestBody = { model, messages, stream: true, tools };

  fs.writeFileSync('logs/test-request-body.json', JSON.stringify(requestBody, null, 2));
  console.log('Saved request body to logs/test-request-body.json');

  console.log('\n--- Test 1: With tools + stream ---');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  console.log(`Status: ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const errorBody = await res.text();
    console.log(`Error body: ${errorBody}`);
    fs.writeFileSync('logs/test-error-response.txt', errorBody);

    console.log('\n--- Test 2: Without tools (baseline) ---');
    const res2 = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
    });
    console.log(`Status: ${res2.status}`);
    if (res2.ok) {
      const text = await res2.text();
      console.log(`Response (first 300): ${text.slice(0, 300)}`);
    } else {
      console.log(`Error: ${await res2.text()}`);
    }

    console.log('\n--- Test 3: Tools but no system prompt tools JSON ---');
    const shortSystem = '你是一个智能任务管理助手。主动使用工具完成任务。';
    const res3 = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: shortSystem }, messages[1]], stream: true, tools }),
    });
    console.log(`Status: ${res3.status}`);
    if (res3.ok) {
      const text = await res3.text();
      console.log(`Response (first 300): ${text.slice(0, 300)}`);
    } else {
      console.log(`Error: ${await res3.text()}`);
    }
    return;
  }

  const text = await res.text();
  let fullContent = '';
  let toolCalls = 0;
  for (const block of text.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6);
    if (payload === '[DONE]') break;
    try {
      const parsed = JSON.parse(payload);
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.content) fullContent += delta.content;
      if (delta?.tool_calls) toolCalls += delta.tool_calls.length;
    } catch {}
  }
  console.log(`\nSuccess! Content: ${fullContent.slice(0, 200)}`);
  console.log(`Tool calls in stream: ${toolCalls}`);
}

main().catch(e => { console.error(e); process.exit(1); });
