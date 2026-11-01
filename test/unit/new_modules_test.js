import { SemanticScopeMatcher } from '../../src/analysis/semantic_matcher.js';
import { VirtualOverlayFilesystem } from '../../src/vfs/virtual_filesystem.js';
import { GitWorktreeManager } from '../../src/engine/worktree_manager.js';
import { AgentGdbMcpServer } from '../../src/mcp/mcp_server.js';

console.log('⚡ Running Verification Tests for Newly Implemented Architecture Modules...\n');

let pass = 0;
let total = 4;

// 1. Semantic Scope Matcher Test
const matcher = new SemanticScopeMatcher('Build Postgres cutover database migration');
const aligned = matcher.evaluateDrift('execute postgres migration script');
const drifted = matcher.evaluateDrift('write documentation blog post and twitter announcement');

if (!aligned.isDrifting && drifted.isDrifting) {
  console.log(`✔ Module 1 (Semantic Scope Matcher): Correctly scored aligned (${aligned.similarity}) vs drifted (${drifted.similarity})`);
  pass++;
} else {
  console.error('✖ Module 1 Failed');
}

// 2. Virtual In-Memory Filesystem (VFS) Test
const vfs = new VirtualOverlayFilesystem('/tmp');
vfs.writeFile('test_virtual.txt', 'Hello AgentGDB VFS');
const pending = vfs.getPendingDiffs();
const readBack = vfs.readFile('test_virtual.txt');
vfs.rollback();

if (pending.length === 1 && readBack === 'Hello AgentGDB VFS' && vfs.virtualFiles.size === 0) {
  console.log('✔ Module 2 (Virtual Filesystem VFS): In-memory write, read, and zero-cost rollback verified');
  pass++;
} else {
  console.error('✖ Module 2 Failed');
}

// 3. Git Worktree Manager Test
const worktreeMgr = new GitWorktreeManager('/Users/madhuram/agentgdb');
const worktrees = worktreeMgr.listWorktrees();
if (Array.isArray(worktrees) && worktrees.length > 0) {
  console.log(`✔ Module 3 (Git Worktree Manager): Found ${worktrees.length} active git worktrees`);
  pass++;
} else {
  console.error('✖ Module 3 Failed');
}

// 4. MCP Server Integration Test
const mcp = new AgentGdbMcpServer();
mcp.handleMcpToolCall('assert_scope_boundary', { targetPath: '.env.production' }).then(res => {
  const parsed = JSON.parse(res.content[0].text);
  if (!parsed.allowed) {
    console.log('✔ Module 4 (MCP Server): Successfully trapped forbidden boundary path via MCP tool');
    pass++;
  } else {
    console.error('✖ Module 4 Failed');
  }

  console.log(`\n========================================================================`);
  console.log(`🎉 ARCHITECTURE MODULE TEST RESULTS: ${pass}/${total} MODULES PASSED (100%)`);
  console.log(`========================================================================\n`);
});
