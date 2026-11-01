# AgentGDB 🕵️‍♂️⚡
> **Chrome DevTools & GDB for Autonomous AI Agent Loops.**  
> *Time-travel, pause on destructive tool calls, rewind derailed steps, and fork zero-cost execution branches.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node: 18+](https://img.shields.io/badge/node-18%2B-brightgreen.svg)]()
[![Zero Framework Lock-in](https://img.shields.io/badge/Frameworks-LangChain%20%7C%20CrewAI%20%7C%20OpenAI%20%7C%20Anthropic-orange.svg)]()

---

## ⚡ The Problem: Why Agents Break in Production

When an autonomous coding or research agent loops for 20 steps:
1. At step 14, a tool output returns a slightly malformed error code or unexpected path.
2. The agent spirals into hallucinations across steps 15–20 and crashes.
3. **Today's developer experience**: Read through 5,000 lines of chaotic terminal logs, edit the code, and **re-run from step 1**, burning \$2.00 in wasted tokens and waiting another 5 minutes.

---

## 🚀 The Solution: AgentGDB

AgentGDB runs as a local, lightweight wire-level proxy daemon (`:8080`) that intercepts agent LLM calls and tool executions:

- ⏪ **Time-Travel Step Timeline**: Inspect exact context windows, token consumption, and tool proposals turn-by-turn.
- 🔀 **Zero-Cost Forking ("Fork from Step N")**: Rewind to step 14, edit what the tool or prompt *should* have returned, and resume. Steps 1–13 are replayed instantly from local SQLite cache (**\$0.00 cost, 0ms latency**).
- 🛑 **Destructive Action Breakpoints**: Automatically freeze agent execution when high-risk tools are called (e.g., `bash`, `delete_file`, `git_push`) so you can inspect and approve before execution.
- 🔌 **Zero Code Changes**: Point your agent's `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL` to `http://localhost:8080/v1` and you're debugging immediately.

---

## 📦 Quickstart

```bash
# Clone and start the daemon
git clone https://github.com/your-username/agentgdb.git
cd agentgdb
npm install
npm start
```

Open your browser to:
👉 **`http://localhost:8080`**

### Route your agent through AgentGDB:

In Python:
```python
import openai

client = openai.OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="your-api-key",
    default_headers={"x-agentgdb-session": "my-coding-agent"}
)
```

In TypeScript / Node:
```typescript
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "http://localhost:8080/v1",
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { "x-agentgdb-session": "my-coding-agent" }
});
```

---

## 🛠️ Architecture

- **Proxy Engine**: Fastify high-throughput transparent SSE reverse proxy.
- **Tape Store**: SQLite local DAG store at `~/.agentgdb/traces.db`.
- **Frontend Console**: Real-time WebSocket visual debugger built with Tailwind & JetBrains Mono.

---

## 📄 License
MIT © 2026
