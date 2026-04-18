const apiKey = process.env.GLM_API_KEY!;
const baseUrl = 'https://open.bigmodel.cn/api/coding/paas/v4';
const model = 'glm-5-turbo';

const tools = [
  { type: 'function', function: { name: 'task_create', description: 'Create task', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } },
];

async function testFix(nameField: string, extra: Record<string, any> = {}) {
  const messages: any[] = [
    { role: 'system', content: '你是任务管理助手。' },
    { role: 'user', content: '创建任务叫测试' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_001', type: 'function', function: { name: 'task_create', arguments: '{"title":"测试"}' } }],
    },
    { role: 'tool', content: '{"id":1,"title":"测试"}', tool_call_id: 'call_001', ...extra },
  ];

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, tools }),
  });

  console.log(`${nameField}: ${res.status}`);
  if (!res.ok) {
    const err = await res.text();
    console.log(`  Error: ${err.slice(0, 200)}`);
  } else {
    const data: any = await res.json();
    console.log(`  OK: ${data.choices?.[0]?.message?.content?.slice(0, 100)}`);
  }
}

async function main() {
  console.log('=== Test: tool message with name field ===\n');
  await testFix('with name=task_create', { name: 'task_create' });
  await testFix('without name', {});
  await testFix('with tool_calls type in assistant', {});
}

main().catch(e => { console.error(e); process.exit(1); });
