const BASE = process.argv[2] || 'http://localhost:8787';

async function api(method: string, path: string, body?: any, headers?: Record<string, string>) {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  return { status: res.status, body: text };
}

async function main() {
  console.log(`Testing against: ${BASE}\n`);

  // 1. Create user
  console.log('--- Step 1: Create user ---');
  const userRes = await api('POST', '/api/user/create', { email: `test${Date.now()}@example.com`, name: '测试用户' });
  console.log(`Status: ${userRes.status}`);
  const user = JSON.parse(userRes.body);
  console.log(`User ID: ${user.id}`);
  const userId = String(user.id);

  // 2. Create conversation
  console.log('\n--- Step 2: Create conversation ---');
  const convRes = await api('POST', '/api/conversations/create', { userId: user.id }, { 'X-User-Id': userId });
  console.log(`Status: ${convRes.status}`);
  const conv = JSON.parse(convRes.body);
  console.log(`Conv ID: ${conv.id}`);

  // 3. Send chat message (SSE stream)
  console.log('\n--- Step 3: Send chat message ---');
  const chatRes = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
    body: JSON.stringify({ convId: conv.id, content: '帮我创建两个任务：\n1. 下午 1:00 之前记得吃饭\n2. 下午 3:00 的时候出去踢足球' }),
  });

  console.log(`Status: ${chatRes.status}`);
  console.log(`Content-Type: ${chatRes.headers.get('content-type')}`);

  if (!chatRes.ok) {
    const errorText = await chatRes.text();
    console.log(`Error: ${errorText}`);
    return;
  }

  // Read SSE stream
  const reader = chatRes.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let toolCalls = 0;
  let toolResults = 0;
  let statuses = 0;
  let errors = 0;
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') {
        console.log('\n[DONE]');
        continue;
      }
      try {
        const event = JSON.parse(data);
        switch (event.type) {
          case 'text':
            process.stdout.write(event.content);
            fullText += event.content;
            break;
          case 'tool_call':
            toolCalls++;
            console.log(`\n[TOOL_CALL] ${event.name}(${JSON.stringify(event.args)?.slice(0, 80)}) id=${event.call_id}`);
            break;
          case 'tool_result':
            toolResults++;
            console.log(`[TOOL_RESULT] ${event.name} (${event.result?.length ?? 0} chars)`);
            break;
          case 'status':
            statuses++;
            console.log(`[STATUS] ${event.content}`);
            break;
          case 'error':
            errors++;
            console.log(`[ERROR] ${event.content}`);
            break;
        }
      } catch {}
    }
  }

  console.log(`\n\n--- Summary ---`);
  console.log(`Full text: ${fullText.slice(0, 200)}`);
  console.log(`Text length: ${fullText.length}`);
  console.log(`Tool calls: ${toolCalls}`);
  console.log(`Tool results: ${toolResults}`);
  console.log(`Statuses: ${statuses}`);
  console.log(`Errors: ${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
