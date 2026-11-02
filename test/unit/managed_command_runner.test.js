import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runManagedCommand } from '../../src/security/managed_command_runner.js';

for (const mode of ['timeout', 'cancellation']) {
  test(`managed command ${mode} terminates descendant processes`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentgdb-command-${mode}-`));
    const startedMarker = path.join(directory, 'child-started');
    const survivorMarker = path.join(directory, 'child-survived');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const childScript = [
      `require('node:fs').writeFileSync(${JSON.stringify(startedMarker)}, 'started')`,
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(survivorMarker)}, 'survived'), 1800)`
    ].join(';');
    const parentScript = `require('node:child_process').spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
    const controller = new AbortController();
    const command = runManagedCommand(process.execPath, ['-e', parentScript], {
      cwd: directory,
      env: process.env,
      timeoutMs: mode === 'timeout' ? 350 : 5000,
      signal: mode === 'cancellation' ? controller.signal : undefined
    });

    if (mode === 'cancellation') {
      const deadline = Date.now() + 1500;
      while (!fs.existsSync(startedMarker) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(fs.existsSync(startedMarker), true, 'descendant process started before cancellation');
      controller.abort();
    }

    await assert.rejects(command, (error) => {
      assert.equal(error.code, mode === 'timeout' ? 'ETIMEDOUT' : 'ABORT_ERR');
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.equal(fs.existsSync(survivorMarker), false, 'descendant did not survive command termination');
  });
}

test('managed command rejects output overflow after terminating its process group', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-command-output-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = 'setInterval(() => process.stdout.write("x".repeat(4096)), 1)';
  await assert.rejects(runManagedCommand(process.execPath, ['-e', script], {
    cwd: directory, env: process.env, timeoutMs: 5000, maxOutputBytes: 8192
  }), (error) => error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
});
