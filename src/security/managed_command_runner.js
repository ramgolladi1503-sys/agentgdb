import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 500;

function commandError(message, code, stdout = '', stderr = '') {
  const error = new Error(message);
  error.code = code;
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

function signalProcessGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function terminatePosixTree(pid) {
  signalProcessGroup(pid, 'SIGTERM');
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        signalProcessGroup(pid, 'SIGKILL');
        resolve();
      } catch (error) {
        reject(error);
      }
    }, TERMINATION_GRACE_MS);
  });
}

function terminateWindowsTree(pid, systemRoot) {
  if (typeof systemRoot !== 'string' || !systemRoot) {
    return Promise.reject(new Error('SystemRoot is unavailable; cannot guarantee Windows process-tree termination.'));
  }
  const taskkill = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
  return new Promise((resolve, reject) => {
    const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore'
    });
    let settled = false;
    killer.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Could not start Windows process-tree termination: ${error.message}`));
    });
    killer.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) return resolve();
      reject(new Error(`taskkill failed with exit code ${code}; process-tree termination was not confirmed.`));
    });
  });
}

async function terminateTree(pid, platform, systemRoot) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === 'win32') return terminateWindowsTree(pid, systemRoot);
  await terminatePosixTree(pid);
}

/**
 * Execute one already-approved executable without a shell. On cancellation,
 * timeout, or output overflow, terminate its process group/tree. This is
 * process lifecycle management, not a sandbox; detached descendants may escape.
 */
export function runManagedCommand(executable, args, {
  cwd,
  env,
  timeoutMs,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  signal,
  platform = process.platform,
  systemRoot = process.env.SystemRoot
} = {}) {
  if (signal?.aborted) return Promise.reject(commandError('Command cancelled before it started.', 'ABORT_ERR'));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(new TypeError('timeoutMs must be a positive integer.'));
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) return Promise.reject(new TypeError('maxOutputBytes must be a positive integer.'));

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd, env, shell: false, windowsHide: true, detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = { stdout: [], stderr: [] };
    let outputBytes = 0;
    let timeout;
    let terminationError = null;
    let terminationPromise = null;
    let settled = false;

    const text = (stream) => Buffer.concat(output[stream]).toString('utf8');
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      error.stdout ??= text('stdout');
      error.stderr ??= text('stderr');
      reject(error);
    };
    const requestTermination = (error) => {
      if (terminationError) return;
      terminationError = error;
      terminationPromise = terminateTree(child.pid, platform, systemRoot).catch((terminationFailure) => {
        terminationError = commandError(
          `${error.message} Process-tree termination could not be confirmed: ${terminationFailure.message}`,
          'ETREEKILL'
        );
      });
    };
    const onAbort = () => requestTermination(commandError('Command cancelled; terminating its process tree.', 'ABORT_ERR'));
    const collect = (stream) => (chunk) => {
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) output[stream].push(chunk.subarray(0, remaining));
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        requestTermination(commandError(`Command output exceeded the ${maxOutputBytes}-byte limit; terminating its process tree.`, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'));
      }
    };

    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.once('error', (error) => finishError(error));
    child.once('spawn', () => {
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      timeout = setTimeout(() => requestTermination(commandError(`Command timed out after ${timeoutMs} ms; terminating its process tree.`, 'ETIMEDOUT')), timeoutMs);
    });
    child.once('close', async (code, childSignal) => {
      if (settled) return;
      cleanup();
      if (terminationError) {
        try { await terminationPromise; }
        catch (error) {
          terminationError = commandError(`${terminationError.message} Process-tree termination could not be confirmed: ${error.message}`, 'ETREEKILL');
        }
        finishError(terminationError);
        return;
      }
      if (code !== 0) {
        finishError(commandError(`Command exited with ${childSignal ? `signal ${childSignal}` : `status ${code}`}.`, Number.isInteger(code) ? code : 'ECHILD'));
        return;
      }
      settled = true;
      resolve({ stdout: text('stdout'), stderr: text('stderr'), exitCode: code });
    });
  });
}
