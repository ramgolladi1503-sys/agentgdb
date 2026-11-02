import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceIdFromName } from '../../public/workspace_id.js';

test('workspace IDs are normalized into readable lowercase slugs', () => {
  assert.equal(workspaceIdFromName('  My Café / API  '), 'my-cafe-api');
});

test('workspace ID normalization handles empty and non-ASCII-only names', () => {
  assert.equal(workspaceIdFromName(''), '');
  assert.equal(workspaceIdFromName('東京'), '');
  assert.equal(workspaceIdFromName(null), '');
});

test('workspace ID suggestions avoid existing IDs case-insensitively', () => {
  assert.equal(workspaceIdFromName('AgentGDB', ['agentgdb']), 'agentgdb-2');
  assert.equal(workspaceIdFromName('AgentGDB', ['agentgdb', 'AGENTGDB-2']), 'agentgdb-3');
});

test('workspace IDs are capped at 63 characters without a trailing separator', () => {
  const id = workspaceIdFromName(`${'a'.repeat(61)} abcdefgh`);
  assert.equal(id.length, 63);
  assert.equal(id.endsWith('-'), false);
});
