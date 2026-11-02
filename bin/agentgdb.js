#!/usr/bin/env node

import { runTerminalTop } from '../src/tui/terminal_top.js';

const args = process.argv.slice(2);
const command = args[0] || 'start';

if (command === 'top') {
  runTerminalTop();
} else if (command === 'start') {
  import('../src/server.js');
} else if (command === 'help' || command === '--help') {
  console.log(`
AgentGDB — local coding-agent session inspector and supervised MCP tools

Usage:
  agentgdb start        Start the local dashboard and session observer (127.0.0.1:9099)
  agentgdb top          Open the experimental terminal session monitor
  agentgdb help         Show this help message

Getting started:
  1. Run "agentgdb start" and open http://127.0.0.1:9099/.
  2. Try the privacy-safe demo, or register a workspace and optional JSONL transcript.
  3. For supervised file or command actions, connect the MCP adapter and keep
     alternate agent filesystem and terminal tools disabled.

AgentGDB observes transcripts after they are written; observation does not
control agent execution. The MCP adapter gates only actions made through its
tools. It is not an operating-system sandbox. See the README for setup and limits.
`);
} else {
  console.log(`Unknown command: ${command}. Run "agentgdb help" for options.`);
}
