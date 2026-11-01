// Simulates a 5-step autonomous coding agent loop talking through AgentGDB proxy
const PROXY_URL = 'http://localhost:8080/v1/chat/completions';
const SESSION_ID = 'demo-coding-agent-01';

async function callAgentTurn(turnIndex, userPrompt, previousToolResult = null) {
  console.log(`\n▶ [Agent Turn #${turnIndex}]: Sending step to AgentGDB proxy...`);
  
  const messages = [
    { role: 'system', content: 'You are an autonomous debugging agent.' },
    { role: 'user', content: userPrompt }
  ];

  if (previousToolResult) {
    messages.push({
      role: 'tool',
      tool_call_id: `call_${turnIndex - 1}`,
      content: JSON.stringify(previousToolResult)
    });
  }

  // Simulated request payload matching OpenAI /v1 format
  const payload = {
    model: 'gpt-4o',
    messages: messages,
    tools: [
      {
        type: 'function',
        function: {
          name: turnIndex === 3 ? 'bash_run' : 'read_file',
          description: 'Execute tool command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
        }
      }
    ]
  };

  try {
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentgdb-session': SESSION_ID
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    console.log(`✔ [Agent Turn #${turnIndex}]: Received response (status ${res.status})`);
    return data;
  } catch (err) {
    console.error(`✖ Turn #${turnIndex} failed:`, err.message);
  }
}

async function runDemo() {
  console.log(`Starting mock agent simulation session: ${SESSION_ID}...`);
  await callAgentTurn(1, "Scan repo for memory leaks");
  await callAgentTurn(2, "Inspect /src/allocator.c");
  await callAgentTurn(3, "Execute bash: valgrind --leak-check=full ./bin/test");
  console.log('\nSimulation completed! Check http://localhost:8080 to inspect the timeline and fork!');
}

runDemo();
