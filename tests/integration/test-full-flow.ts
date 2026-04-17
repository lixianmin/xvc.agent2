const apiKey = process.env.GLM_API_KEY!;
const baseUrl = 'https://open.bigmodel.cn/api/coding/paas/v4';
const model = 'GLM-5';

const tools = [
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

async function main() {
  // Step 1: First round - just user message
  const systemPrompt = '你是智能任务管理助手。';
  const round1Messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '帮我创建两个任务：\n1. 下午 1:00 之前记得吃饭\n2. 下午 3:00 的时候出去踢足球' },
  ];

  console.log('=== Round 1: User message ===');
  const res1 = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: round1Messages, stream: false, tools }),
  });

  console.log(`Status: ${res1.status}`);
  if (!res1.ok) {
    console.log(`Error: ${await res1.text()}`);
    return;
  }

  const data1: any = await res1.json();
  const assistantMsg = data1.choices[0].message;
  console.log(`Assistant content: ${assistantMsg.content?.slice(0, 200)}`);
  console.log(`Tool calls: ${JSON.stringify(assistantMsg.tool_calls, null, 2)}`);

  if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
    console.log('No tool calls, done');
    return;
  }

  // Step 2: Build round 2 messages exactly as AgentLoop does
  const round2Messages: any[] = [
    ...round1Messages,
    assistantMsg, // the full assistant message with tool_calls
  ];

  for (const tc of assistantMsg.tool_calls) {
    round2Messages.push({
      role: 'tool',
      content: `{"id":${Math.floor(Math.random()*1000)},"title":"${tc.function.arguments}","status":"pending"}`,
      tool_call_id: tc.id,
    });
  }

  console.log('\n=== Round 2: With tool results ===');
  console.log('Messages structure:');
  round2Messages.forEach((m, i) => {
    console.log(`  [${i}] role=${m.role}, content=${typeof m.content === 'string' ? `(${m.content.length} chars)` : m.content}, tool_calls=${!!m.tool_calls}, tool_call_id=${m.tool_call_id || ''}`);
  });

  const res2 = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: round2Messages, stream: false, tools }),
  });

  console.log(`\nStatus: ${res2.status}`);
  if (!res2.ok) {
    const errText = await res2.text();
    console.log(`Error: ${errText}`);

    // Save for analysis
    const fs = await import('fs');
    fs.writeFileSync('logs/round2-debug.json', JSON.stringify({ messages: round2Messages, tools, error: errText }, null, 2));
    console.log('Saved to logs/round2-debug.json');

    // Try with content: null instead of content: ""
    console.log('\n=== Round 2b: Try with content=null for assistant ===');
    round2Messages[2] = { ...round2Messages[2], content: null };
    const res2b = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: round2Messages, stream: false, tools }),
    });
    console.log(`Status: ${res2b.status}`);
    if (!res2b.ok) console.log(`Error: ${await res2b.text()}`);
    else console.log('OK!');
  } else {
    const data2: any = await res2.json();
    console.log(`Content: ${data2.choices[0].message.content?.slice(0, 200)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
