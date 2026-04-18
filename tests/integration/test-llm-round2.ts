import * as fs from 'fs';

const apiKey = process.env.GLM_API_KEY!;
const baseUrl = 'https://open.bigmodel.cn/api/coding/paas/v4';
const model = 'glm-5-turbo';

async function testRound2() {
  console.log('=== Test: Round 2 with tool results in messages ===\n');

  const tools = [
    { type: 'function', function: { name: 'task_create', description: 'Create a new task', parameters: { type: 'object', properties: { title: { type: 'string', description: 'Task title' }, description: { type: 'string', description: 'Task description' }, priority: { type: 'string', enum: ['low', 'medium', 'high'] } }, required: ['title'] } } },
    { type: 'function', function: { name: 'task_list', description: 'List tasks', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'] } } } } },
  ];

  const messages = [
    { role: 'system', content: '你是任务管理助手。主动使用工具。' },
    { role: 'user', content: '帮我创建两个任务：\n1. 下午1点前吃饭\n2. 下午3点踢足球' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_001', function: { name: 'task_create', arguments: '{"title":"下午1:00之前记得吃饭"}' } },
        { id: 'call_002', function: { name: 'task_create', arguments: '{"title":"下午3:00的时候出去踢足球"}' } },
      ],
    },
    { role: 'tool', content: '{"id":1,"title":"下午1:00之前记得吃饭","status":"pending","priority":"medium"}', tool_call_id: 'call_001' },
    { role: 'tool', content: '{"id":2,"title":"下午3:00的时候出去踢足球","status":"pending","priority":"medium"}', tool_call_id: 'call_002' },
  ];

  const requestBody = { model, messages, stream: true, tools };
  fs.writeFileSync('logs/test-round2-request.json', JSON.stringify(requestBody, null, 2));

  console.log('Sending round 2 request...');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  console.log(`Status: ${res.status} ${res.statusText}`);
  if (!res.ok) {
    const errorBody = await res.text();
    console.log(`Error: ${errorBody}`);
    fs.writeFileSync('logs/test-round2-error.txt', errorBody);
    return;
  }

  const text = await res.text();
  let fullContent = '';
  for (const block of text.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6);
    if (payload === '[DONE]') break;
    try {
      const parsed = JSON.parse(payload);
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.content) fullContent += delta.content;
    } catch {}
  }
  console.log(`Content: ${fullContent}`);
}

async function testEmptyContent() {
  console.log('\n=== Test: assistant with empty content + tool_calls ===\n');

  const messages = [
    { role: 'system', content: '你是任务管理助手。' },
    { role: 'user', content: '创建一个任务叫测试' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_001', function: { name: 'task_create', arguments: '{"title":"测试"}' } },
      ],
    },
    { role: 'tool', content: '{"id":1,"title":"测试"}', tool_call_id: 'call_001' },
  ];

  const tools = [
    { type: 'function', function: { name: 'task_create', description: 'Create task', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } },
  ];

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, tools }),
  });

  console.log(`Status: ${res.status}`);
  if (!res.ok) {
    console.log(`Error: ${await res.text()}`);
  } else {
    let content = '';
    const text = await res.text();
    for (const block of text.split('\n\n')) {
      const line = block.trim();
      if (!line.startsWith('data: ') || line.slice(6) === '[DONE]') continue;
      try { const p = JSON.parse(line.slice(6)); if (p.choices?.[0]?.delta?.content) content += p.choices[0].delta.content; } catch {}
    }
    console.log(`Content: ${content}`);
  }
}

async function testNullContent() {
  console.log('\n=== Test: assistant with null content ===\n');

  const messages = [
    { role: 'system', content: '你是任务管理助手。' },
    { role: 'user', content: '创建一个任务叫测试' },
    {
      role: 'assistant',
      content: null as any,
      tool_calls: [
        { id: 'call_001', function: { name: 'task_create', arguments: '{"title":"测试"}' } },
      ],
    },
    { role: 'tool', content: '{"id":1,"title":"测试"}', tool_call_id: 'call_001' },
  ];

  const tools = [
    { type: 'function', function: { name: 'task_create', description: 'Create task', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } },
  ];

  const body = { model, messages, stream: true, tools };
  console.log('Request body (messages):');
  messages.forEach((m, i) => console.log(`  [${i}] role=${m.role}, content=${JSON.stringify(m.content)?.slice(0, 50)}, tool_calls=${!!(m as any).tool_calls}, tool_call_id=${(m as any).tool_call_id}`));

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  console.log(`Status: ${res.status}`);
  if (!res.ok) {
    console.log(`Error: ${await res.text()}`);
  } else {
    console.log('OK');
  }
}

async function main() {
  await testRound2();
  await testEmptyContent();
  await testNullContent();
}

main().catch(e => { console.error(e); process.exit(1); });
