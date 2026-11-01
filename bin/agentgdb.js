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
AgentGDB CLI 🕵️‍♂️⚡
Chrome DevTools & GDB for Autonomous Coding Agents

Usage:
  agentgdb start        Start the background streaming daemon and web console (:9099)
  agentgdb top          Open headless terminal TUI monitoring in split tmux panes
  agentgdb help         Display this help message
`);
} else {
  console.log(`Unknown command: ${command}. Run "agentgdb help" for options.`);
}
