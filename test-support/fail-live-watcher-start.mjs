import { LiveSessionStreamWatcher } from '../src/live_session_stream.js';

const originalStart = LiveSessionStreamWatcher.prototype.start;
LiveSessionStreamWatcher.prototype.start = async function (...args) {
  if (this.filePath === process.env.AGENTGDB_TEST_FAIL_WATCHER_PATH) {
    throw new Error('injected watcher startup failure');
  }
  return originalStart.apply(this, args);
};
