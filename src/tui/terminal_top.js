import readline from 'readline';

/**
 * Task 66: Terminal Headless TUI (`agentgdb top`)
 * Compact terminal dashboard that runs in split tmux / terminal panes
 * displaying active goal, live drift alerts, and token velocity without opening a browser.
 */
export function runTerminalTop(options = {}) {
  const host = options.host || 'http://localhost:9099';
  console.clear();

  const printHeader = (data = {}) => {
    process.stdout.write('\x1b[?25l'); // Hide cursor
    readline.cursorTo(process.stdout, 0, 0);

    const goal = (data.activeGoal || 'Listening for active agent stream...').slice(0, 65);
    const steps = data.totalSteps || 0;
    const duration = data.elapsedHours || 0;
    const drifts = data.totalDrifts || 0;
    const status = drifts > 0 ? '\x1b[31m● DRIFT DETECTED\x1b[0m' : '\x1b[32m● ON TRACK\x1b[0m';

    console.log(`\x1b[1m\x1b[36m╔══════════════════════════════════════════════════════════════════════════════╗\x1b[0m`);
    console.log(`\x1b[1m\x1b[36m║  AgentGDB Top — Autonomous Agent Headless Monitor                            ║\x1b[0m`);
    console.log(`\x1b[1m\x1b[36m╠══════════════════════════════════════════════════════════════════════════════╣\x1b[0m`);
    console.log(`  \x1b[1mStatus:\x1b[0m ${status}   \x1b[1mDuration:\x1b[0m ${duration}h   \x1b[1mSteps:\x1b[0m ${steps}   \x1b[1mDrifts:\x1b[0m \x1b[31m${drifts}\x1b[0m`);
    console.log(`  \x1b[1mActive Goal:\x1b[0m \x1b[33m${goal}\x1b[0m`);
    console.log(`\x1b[36m╟──────────────────────────────────────────────────────────────────────────────╢\x1b[0m`);
    console.log(`  \x1b[1m[Recent Tool Executions & Invariant Traps]\x1b[0m`);

    const recent = data.recentSteps || [
      { step: 1, tool: 'read_file', target: 'src/server.js', status: 'IN_SCOPE' },
      { step: 2, tool: 'edit_file', target: 'src/db.js', status: 'IN_SCOPE' }
    ];

    recent.slice(-6).forEach(s => {
      const tag = s.status === 'IN_SCOPE' ? '\x1b[32m[IN_SCOPE]\x1b[0m' : '\x1b[31m[DRIFT]\x1b[0m';
      console.log(`   #${s.step}  ${(s.tool || '').padEnd(12)} ${(s.target || '').slice(0, 42).padEnd(44)} ${tag}`);
    });

    console.log(`\x1b[36m╚══════════════════════════════════════════════════════════════════════════════╝\x1b[0m`);
    console.log(`  \x1b[90mPress Ctrl+C to exit top • Web UI active at http://localhost:9099\x1b[0m`);
  };

  // Poll loop
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`${host}/api/live/active-goal`);
      const data = await res.json();
      printHeader(data);
    } catch (e) {
      printHeader({ activeGoal: 'Waiting for AgentGDB daemon on port 9099...' });
    }
  }, 1000);

  process.on('SIGINT', () => {
    clearInterval(timer);
    process.stdout.write('\x1b[?25h'); // Restore cursor
    console.log('\nAgentGDB Top exited.');
    process.exit(0);
  });
}
