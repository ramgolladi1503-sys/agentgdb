import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretLeakInterceptor } from '../../src/security/secret_leak_interceptor.js';
import { InvariantEngine } from '../../src/engine/invariant_engine.js';
import { AttestationAndPrSummaryService } from '../../src/governance/attestation_service.js';
import { WorkspaceConfigDetector } from '../../src/services/workspace_detector.js';

test('narrow unit probes for selected input patterns (not a red-team certification)', async (t) => {
  const leakScanner = new SecretLeakInterceptor();
  await t.test('detects selected OpenAI-like token pattern', () => assert.equal(leakScanner.scan("export OPENAI_API_KEY='sk-1234567890abcdef1234567890abcdef'").safe, false));
  await t.test('detects selected AWS key pattern', () => assert.equal(leakScanner.scan('aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE').safe, false));
  await t.test('invariant engine flags configured forbidden substring', () => {
    const result = new InvariantEngine({ forbiddenPaths: ['docs/'] }).evaluateStep({ toolName: 'write_file', targetPath: 'docs/a.md' });
    assert.equal(result.halt, true);
    assert.equal(result.category, 'BLAST_RADIUS_VIOLATION');
  });
  await t.test('invariant engine flags repeated reads at configured threshold', () => {
    const engine = new InvariantEngine({ maxConsecutiveReads: 2 });
    engine.evaluateStep({ toolName: 'read_file', targetPath: 'src/a.js' });
    const result = engine.evaluateStep({ toolName: 'read_file', targetPath: 'src/b.js' });
    assert.equal(result.category, 'STAGNATION_LOOP_HALT');
  });
  await t.test('invariant engine flags token limit breach', () => {
    const engine = new InvariantEngine({ tokenBudget: 5 });
    engine.evaluateStep({ toolName: 'edit_file', targetPath: 'src/a.js', tokens: 3 });
    assert.equal(engine.evaluateStep({ toolName: 'edit_file', targetPath: 'src/a.js', tokens: 3 }).category, 'BUDGET_EXCEEDED_HALT');
  });
  await t.test('invariant engine flags repeated documentation writes', () => {
    const engine = new InvariantEngine({ maxConsecutiveDocs: 2 });
    engine.evaluateStep({ toolName: 'write_file', targetPath: 'notes.md' });
    assert.equal(engine.evaluateStep({ toolName: 'write_file', targetPath: 'audit.md' }).category, 'DOCS_JOURNALING_HALT');
  });
  await t.test('attestation helper emits one block per fixture turn', () => {
    const ledger = AttestationAndPrSummaryService.generateAttestationLedger({ id: 'session', turns: [
      { id: 't1', turn_index: 1, tool_calls: 'edit', tool_results: 'ok', created_at: 1 },
      { id: 't2', turn_index: 2, tool_calls: 'test', tool_results: 'pass', created_at: 2 }
    ] });
    assert.equal(ledger.blocks.length, 2);
    assert.match(ledger.chainHead, /^[a-f0-9]{64}$/);
    assert.equal(ledger.blocks[0].integrity, 'HASHED_NOT_VERIFIED');
    assert.equal(ledger.blocks[1].previousHash, ledger.blocks[0].hash);
  });
  await t.test('summary output has expected section heading only; it is not proof', () => {
    const summary = AttestationAndPrSummaryService.generatePrSummaryMarkdown({ id: 'session' }, { totalSteps: 2, inScopeSteps: 2 });
    assert.match(summary, /session summary \(unverified\)/);
    assert.doesNotMatch(summary, /HEALTHY|Attestation Seal|Cryptographically Verified/);
  });
  await t.test('missing workspace detector returns null', () => assert.equal(WorkspaceConfigDetector.detect('/path/that/does/not/exist/agentgdb-fixture'), null));
  await t.test('detects selected private key block marker', () => {
    const result = leakScanner.scan('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----');
    assert.equal(result.safe, false);
    assert.equal(result.leakType, 'Private Key Block');
  });
});
