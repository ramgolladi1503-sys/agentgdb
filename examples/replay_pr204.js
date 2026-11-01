import { ingestControlTowerEvent } from '../src/control_tower_adapter.js';

console.log('🔄 Ingesting live PR 204 Codex Agentic Loop from Aixion Control Tower...\n');

const SESSION = 'PR-204-Codex-Gate3-Verification';

// Turn 1: Initialization & Thread start
ingestControlTowerEvent(SESSION, 1, 'thread/start', {
  item: { cwd: '/Users/madhuram/aixion-control-tower', command: 'initialize thread' }
}, 'accept', 320);
console.log('✔ Ingested Step 1: Thread Start & Environment Initialization');

// Turn 2: Inspecting test suite for Postgres Cutover
ingestControlTowerEvent(SESSION, 2, 'item/commandExecution/requestApproval', {
  item: {
    id: 'ct-item-1',
    command: ['python', '-m', 'pytest', 'tests/test_postgres_authority.py', '-v'],
    cwd: '/Users/madhuram/aixion-control-tower'
  }
}, 'accept', 890);
console.log('✔ Ingested Step 2: Test Execution [pytest test_postgres_authority.py] -> ALLOWED');

// Turn 3: Auditing SQLite fallback trap (Gate 1 regression trap)
ingestControlTowerEvent(SESSION, 3, 'item/commandExecution/requestApproval', {
  item: {
    id: 'ct-item-2',
    command: ['git', 'diff', '--check', 'backend/app/routes/audit.py'],
    cwd: '/Users/madhuram/aixion-control-tower'
  }
}, 'accept', 410);
console.log('✔ Ingested Step 3: Git Diff Check on Route Audit Fallback -> ALLOWED');

// Turn 4: Gate 3 Native Codex Permission Request (The Halt/Failure point where it stalled!)
ingestControlTowerEvent(SESSION, 4, 'item/commandExecution/requestApproval', {
  item: {
    id: 'ct-item-3',
    command: ['python', '-m', 'aixion_relay.cli', 'rehearse-cutover', '--target', 'production'],
    cwd: '/Users/madhuram/aixion-control-tower'
  }
}, 'pending', 1250);
console.log('✔ Ingested Step 4: High-Risk Action [rehearse-cutover --target production] -> HALTED ON GATE');

console.log('\n========================================================================');
console.log('🎉 Successfully mapped PR 204 agentic loop into AgentGDB!');
console.log('👉 Open http://localhost:9099/index.html to replay, inspect, and fork!');
console.log('========================================================================\n');
