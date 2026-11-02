import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveSessionStreamWatcher } from '../../src/live_session_stream.js';

test('live watcher scans history once and processes only appended complete lines', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-live-incremental-'));
  const file = path.join(dir, 'session.jsonl');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const line = (index) => JSON.stringify({ step_index: index, created_at: new Date().toISOString(), tool_calls: [{ name: 'read_file', args: { path: `src/file-${index}.txt` } }] });
  fs.writeFileSync(file, `${line(1)}\n`);
  const events = [];
  const watcher = new LiveSessionStreamWatcher(file, {}, (event) => events.push(event), () => {}, () => {}, { maxTranscriptBytes: 4096 });
  t.after(() => watcher.stop());

  await watcher.start();
  assert.equal(events.length, 0, 'the initial scan establishes context without re-emitting old timeline events');
  const previousOffset = watcher.fileOffset;
  fs.appendFileSync(file, `${line(2)}\n`);
  await watcher.readNewLines();
  assert.equal(events.length, 1);
  assert.equal(events[0].stepIndex, 2);
  assert.ok(watcher.fileOffset > previousOffset);
  watcher.stop();
});

test('live watcher stops and reports an oversized growing transcript', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-live-limit-'));
  const file = path.join(dir, 'session.jsonl');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta' })}\n`);
  const errors = [];
  const watcher = new LiveSessionStreamWatcher(file, {}, () => {}, () => {}, (error) => errors.push(error), { maxTranscriptBytes: 128 });
  t.after(() => watcher.stop());

  await watcher.start();
  fs.appendFileSync(file, `${'x'.repeat(200)}\n`);
  await watcher.readNewLines();
  assert.equal(watcher.isWatching, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'TRANSCRIPT_TOO_LARGE');
});
