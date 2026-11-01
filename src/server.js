import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, timingSafeEqual, createHash, randomBytes } from 'crypto';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fastify = Fastify({ logger: true });
await fastify.register(websocket);
await fastify.register(fastifyStatic, {
  root: path.join(__dirname, '../public'),
  prefix: '/'
});
import { 
  createSession, 
  getAllSessions, 
  getSession, 
  recordTurn, 
  getTurnsForSession, 
  getReplayTurn,
  getBreakpoints,
  addBreakpoint,
  removeBreakpoint,
  createApproval,
  getApproval,
  getPendingApprovals,
  getRecentApprovals,
  decideApproval,
  expireApproval
} from './db.js';
import { replayManager } from './replayer.js';
import { analyzePullRequestDrift, getCommitDiff } from './git_drift_analyzer.js';
import { UniversalAgentWatcher } from './universal_watcher.js';
import { LiveSessionStreamWatcher } from './live_session_stream.js';
import { loadProjects, saveProject, setActiveProject } from './project_registry.js';
import { applyTraceRetention, purgeTraceDataBefore, rejectPendingApprovals } from './db.js';
import { evaluateScopePolicy, inspectToolCall, pathStaysInWorkspace } from './security/scope_policy.js';
import { redactSensitive, containsSensitiveValue } from './security/redaction.js';

// Upstream target (default to OpenAI standard endpoint, can be overridden via env)
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || 'https://api.openai.com';
const UPSTREAM_TIMEOUT_MS = Number(process.env.AGENTGDB_UPSTREAM_TIMEOUT_MS || 120000);
if (!Number.isInteger(UPSTREAM_TIMEOUT_MS) || UPSTREAM_TIMEOUT_MS < 1000 || UPSTREAM_TIMEOUT_MS > 600000) {
  throw new Error('AGENTGDB_UPSTREAM_TIMEOUT_MS must be an integer from 1000 to 600000');
}
const TRACE_CAPTURE = process.env.AGENTGDB_TRACE_CAPTURE === 'true';
const APPROVAL_TIMEOUT_MS = Number(process.env.AGENTGDB_APPROVAL_TIMEOUT_MS || 300000);
if (!Number.isInteger(APPROVAL_TIMEOUT_MS) || APPROVAL_TIMEOUT_MS < 1000 || APPROVAL_TIMEOUT_MS > 3600000) {
  throw new Error('AGENTGDB_APPROVAL_TIMEOUT_MS must be an integer from 1000 to 3600000');
}
const APPROVAL_TOKEN = process.env.AGENTGDB_APPROVAL_TOKEN || randomBytes(32).toString('base64url');
if (Buffer.byteLength(APPROVAL_TOKEN) < 32) throw new Error('AGENTGDB_APPROVAL_TOKEN must be at least 32 bytes');

function parseChatCompletionStream(text) {
  const result = { id: null, object: 'chat.completion', created: null, model: null, choices: [], usage: undefined };
  const choices = new Map();
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') continue;
    let chunk;
    try { chunk = JSON.parse(data); } catch { throw new Error('Upstream returned malformed chat completion stream data'); }
    result.id = chunk.id || result.id;
    result.object = 'chat.completion';
    result.created = chunk.created ?? result.created;
    result.model = chunk.model || result.model;
    if (chunk.usage) result.usage = chunk.usage;
    for (const item of chunk.choices || []) {
      const index = Number.isInteger(item.index) ? item.index : 0;
      let target = choices.get(index);
      if (!target) {
        target = { index, message: { role: 'assistant', content: '', tool_calls: [] }, finish_reason: null };
        choices.set(index, target);
      }
      const delta = item.delta || {};
      if (delta.role) target.message.role = delta.role;
      if (typeof delta.content === 'string') target.message.content += delta.content;
      for (const partial of delta.tool_calls || []) {
        const toolIndex = partial.index;
        if (!Number.isInteger(toolIndex) || toolIndex < 0) throw new Error('Upstream stream tool call has invalid index');
        let tool = target.message.tool_calls[toolIndex];
        if (!tool) {
          tool = { id: '', type: 'function', function: { name: '', arguments: '' } };
          target.message.tool_calls[toolIndex] = tool;
        }
        if (partial.id) tool.id += partial.id;
        if (partial.type) tool.type = partial.type;
        if (partial.function?.name) tool.function.name += partial.function.name;
        if (partial.function?.arguments) tool.function.arguments += partial.function.arguments;
      }
      if (item.finish_reason !== undefined) target.finish_reason = item.finish_reason;
    }
  }
  result.choices = [...choices.values()].sort((a, b) => a.index - b.index);
  for (const choice of result.choices) if (choice.message.tool_calls.length === 0) delete choice.message.tool_calls;
  return result;
}

function deniedStreamMessage(responseJson, message) {
  const choice = responseJson.choices?.[0] || { index: 0, message: { role: 'assistant' } };
  const base = { id: responseJson.id || `agentgdb-${randomUUID()}`, object: 'chat.completion.chunk', created: responseJson.created || Math.floor(Date.now() / 1000), model: responseJson.model || 'unknown' };
  const events = [
    { ...base, choices: [{ index: choice.index || 0, delta: { role: 'assistant', content: message }, finish_reason: null }] },
    { ...base, choices: [{ index: choice.index || 0, delta: {}, finish_reason: 'stop' }] }
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
}
const HOST = process.env.HOST || '127.0.0.1';
applyTraceRetention();
rejectPendingApprovals();

if (HOST !== '127.0.0.1' && HOST !== '::1' && !process.env.AGENTGDB_AUTH_TOKEN) {
  throw new Error('AGENTGDB_AUTH_TOKEN is required when HOST is not loopback.');
}

fastify.addHook('onRequest', async (req, reply) => {
  if (HOST === '127.0.0.1' || HOST === '::1') return;
  const expected = Buffer.from(process.env.AGENTGDB_AUTH_TOKEN || '');
  const supplied = Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const isHealth = req.method === 'GET' && req.url.split('?')[0] === '/healthz';
  const authorized = supplied.length === expected.length && timingSafeEqual(supplied, expected);
  if (!isHealth && !authorized) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
});

fastify.get('/healthz', async () => ({ status: 'ok' }));

// Broadcast helper to connected UI clients
const uiClients = new Set();
let activeLiveWatcher = null;

function broadcastToUI(eventType, data) {
  const message = JSON.stringify({ event: eventType, data });
  for (const client of uiClients) {
    if (client.readyState === 1) { // OPEN
      client.send(message);
    }
  }
}

// WebSocket endpoint for real-time live debugger UI
fastify.get('/ws', { websocket: true }, (socket, req) => {
  uiClients.add(socket);
  socket.on('close', () => {
    uiClients.delete(socket);
  });
});

// REST APIs for UI Control
fastify.get('/api/sessions', async () => {
  return getAllSessions();
});

fastify.get('/api/sessions/:id/turns', async (req) => {
  const branch = req.query.branch || 'main';
  return getTurnsForSession(req.params.id, branch).map((turn) => ({ ...turn, request_payload: null, response_payload: null, tool_calls: null, tool_results: null }));
});

fastify.get('/api/sessions/:id/replay/:turnIndex', async (req, reply) => {
  const turnIndex = Number(req.params.turnIndex);
  if (!Number.isSafeInteger(turnIndex) || turnIndex < 1) return reply.code(400).send({ error: 'turnIndex must be a positive integer' });
  const turn = getReplayTurn(req.params.id, turnIndex, req.query.branch || 'main');
  if (!turn) return reply.code(404).send({ error: 'Recorded turn not found.' });
  if (!turn.request_payload || !turn.response_payload) return reply.code(409).send({ error: 'Replay unavailable: payload capture was disabled or this trace is incomplete.' });
  const requestHash = createHash('sha256').update(turn.request_payload).digest('hex');
  const responseHash = createHash('sha256').update(turn.response_payload).digest('hex');
  if (requestHash !== turn.request_hash || responseHash !== turn.response_hash) return reply.code(409).send({ error: 'Replay unavailable: trace integrity hash mismatch.' });
  return { sessionId: turn.session_id, turnIndex: turn.turn_index, branch: turn.branch_name, schemaVersion: turn.schema_version, engineVersion: turn.engine_version, request: JSON.parse(turn.request_payload), response: JSON.parse(turn.response_payload), deterministic: true, externalCalls: 0 };
});

fastify.post('/api/live/stop', async () => {
  if (activeLiveWatcher) activeLiveWatcher.stop();
  activeLiveWatcher = null;
  return { success: true, isWatching: false };
});

fastify.post('/api/live/watch', async (req, reply) => {
  const { sessionPath, coreGoals = [], allowedPaths = [], forbiddenPaths = [] } = req.body || {};
  if (typeof sessionPath !== 'string' || !path.isAbsolute(sessionPath)) {
    return reply.code(400).send({ error: 'sessionPath must be an explicit absolute path' });
  }
  if (!fs.existsSync(sessionPath) || !fs.statSync(sessionPath).isFile()) return reply.code(404).send({ error: 'Transcript file not found.' });
  if (activeLiveWatcher) activeLiveWatcher.stop();
  activeLiveWatcher = new LiveSessionStreamWatcher(sessionPath, { coreGoals, allowedPaths, forbiddenPaths },
    (step) => broadcastToUI('live_step_added', step),
    (alert) => broadcastToUI('live_drift_alert', alert));
  await activeLiveWatcher.start();
  return { success: true, isWatching: activeLiveWatcher.isWatching, path: sessionPath };
});

// Live Local Agent Session Watcher API (Antigravity, Codex, Claude Code, Cursor)
fastify.post('/api/local/watch', async (req, reply) => {
  const { sessionPath, coreGoals, allowedPaths, forbiddenPaths } = req.body || {};
  
  const targetPath = sessionPath;
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) return reply.code(400).send({ error: 'An explicit absolute sessionPath is required.' });
  if (!fs.existsSync(targetPath)) return reply.code(404).send({ error: 'Transcript file not found.' });
  if (!fs.statSync(targetPath).isFile()) return reply.code(400).send({ error: 'sessionPath must identify a file.' });
  
  const watcher = new UniversalAgentWatcher({
    definedScope: {
      coreGoals: coreGoals || [],
      allowedPaths: allowedPaths || [],
      forbiddenPaths: forbiddenPaths || []
    }
  });

  const parsed = await watcher.parseSessionTranscript(targetPath);
  if (parsed.totalSteps === 0 && parsed.parseErrors.length > 0) {
    return reply.code(422).send({ error: 'Transcript contains no valid parseable JSONL events.', parseErrors: parsed.parseErrors.slice(0, 100) });
  }
  if (parsed.totalSteps === 0) return reply.code(422).send({ error: 'Transcript is valid JSONL, but no supported agent events were recognized.' });
  if (activeLiveWatcher) activeLiveWatcher.stop();
  activeLiveWatcher = new LiveSessionStreamWatcher(targetPath, watcher.definedScope,
    (step) => broadcastToUI('live_step_added', step),
    (alert) => broadcastToUI('live_drift_alert', alert));
  await activeLiveWatcher.start();
  for (const event of parsed.timeline || []) broadcastToUI('live_step_added', event);
  return { success: true, ...parsed, parseErrorCount: parsed.parseErrors.length };
});

fastify.get('/api/breakpoints', async () => {
  return getBreakpoints();
});

fastify.get('/api/approvals', async () => ({ approvals: getPendingApprovals(), recent: getRecentApprovals() }));

fastify.post('/api/approvals/:id/decision', async (req, reply) => {
  const suppliedToken = Buffer.from(req.headers['x-agentgdb-approval-token'] || '');
  const expectedToken = Buffer.from(APPROVAL_TOKEN);
  if (suppliedToken.length !== expectedToken.length || !timingSafeEqual(suppliedToken, expectedToken)) {
    return reply.code(401).send({ error: 'Valid operator approval token required.' });
  }
  const decision = req.body?.decision;
  if (!['APPROVED', 'DENIED'].includes(decision)) return reply.code(400).send({ error: 'decision must be APPROVED or DENIED' });
  const approval = decideApproval(req.params.id, decision, 'token-holder', req.body?.reason || null);
  if (!approval) return reply.code(409).send({ error: 'Approval is no longer pending or has expired.' });
  broadcastToUI('approval_decided', { id: approval.id, status: approval.status });
  return { success: true, approval };
});

fastify.post('/api/demo/start', async (_req, reply) => {
  // Synthetic fixtures are served in memory only and never written to trace storage.
  const event = { stepIndex: 1, elapsedHours: 0, toolName: 'read_file', targetPath: 'src/example.js', content: 'Synthetic demo event', timestamp: Date.now(), activeGoal: 'Inspect a harmless demo project', drift: { isDrift: false } };
  broadcastToUI('live_step_added', event);
  return reply.send({ success: true, mode: 'synthetic-demo', persisted: false, elapsedHours: event.elapsedHours, message: 'Demo event emitted in memory; no project files, external API, or trace database were used.' });
});

fastify.delete('/api/traces', async (req, reply) => {
  const before = Number(req.query.before);
  if (!Number.isFinite(before)) return reply.code(400).send({ error: 'A numeric before timestamp is required' });
  const includeSessionMetadata = req.query.includeSessionMetadata === 'true';
  return purgeTraceDataBefore(before, { includeSessionMetadata });
});

// Scope & Git Code Drift Replay API
fastify.get('/api/pr/drift', async (req) => {
  const repoPath = req.query.repoPath;
  if (!repoPath) return { error: 'repoPath is required' };
  const prNumber = req.query.pr || '';
  const definedScope = req.query.scope || '';
  const limit = parseInt(req.query.limit || '40', 10);

  const baseRef = req.query.baseRef;
  const headRef = req.query.headRef;
  if (!baseRef || !headRef) return { error: 'baseRef and headRef are required' };

  return analyzePullRequestDrift(repoPath, baseRef, headRef, definedScope, limit);
});

fastify.get('/api/pr/commit-diff', async (req) => {
  const repoPath = req.query.repoPath;
  if (!repoPath) return { error: 'repoPath is required' };
  const hash = req.query.hash;
  if (!hash) return { error: 'Commit hash is required' };
  return { diff: getCommitDiff(repoPath, hash) };
});

fastify.post('/api/breakpoints', async (req) => {
  const { rule_type, pattern } = req.body;
  const id = randomUUID();
  addBreakpoint(id, rule_type, pattern);
  return { success: true, id };
});

fastify.delete('/api/breakpoints/:id', async (req) => {
  removeBreakpoint(req.params.id);
  return { success: true };
});

// UI Control: Resume a paused session (with optional modified tool output)
fastify.post('/api/sessions/:id/resume', async (req) => {
  const { modifiedPayload } = req.body || {};
  const resumed = replayManager.resume(req.params.id, modifiedPayload);
  broadcastToUI('session_resumed', { sessionId: req.params.id });
  return { success: resumed };
});

// UI Control: Fork from turn
fastify.post('/api/sessions/:id/fork', async (req) => {
  const { fromTurnIndex, branchName, mockOverrides } = req.body;
  replayManager.createFork(req.params.id, fromTurnIndex, branchName || `fork_${Date.now()}`, mockOverrides);
  broadcastToUI('fork_created', { sessionId: req.params.id, fromTurnIndex, branchName });
  return { success: true };
});

// The Transparent LLM Proxy endpoint (/v1/chat/completions)
fastify.post('/v1/chat/completions', async (req, reply) => {
  const sessionId = req.headers['x-agentgdb-session'] || 'default-session';
  const model = req.body.model || 'unknown';
  const streamingRequested = req.body.stream === true;
  const startTime = Date.now();

  createSession(sessionId, sessionId, model);

  // Check active breakpoints before executing
  const breakpoints = getBreakpoints();
  const lastMessage = req.body.messages?.[req.body.messages.length - 1];

  let shouldBreak = false;
  let hitRule = null;

  for (const bp of breakpoints) {
    if (bp.rule_type === 'tool_name') {
      // Check if previous turn had this tool result or if messages contain call
      const msgStr = JSON.stringify(lastMessage || {});
      if (msgStr.includes(bp.pattern)) {
        shouldBreak = true;
        hitRule = bp;
        break;
      }
    }
  }

  // If breakpoint hit, pause and notify UI
  if (shouldBreak) {
    broadcastToUI('breakpoint_hit', {
      sessionId,
      rule: hitRule,
      lastMessage
    });
    // Wait for user resume/approval from the UI
    await replayManager.pauseForInspection(sessionId, { lastMessage, rule: hitRule });
  }

  // Check if we are in a fork replay mode
  const fork = replayManager.getFork(sessionId);
  if (fork && fork.currentTurnIndex < fork.fromTurnIndex) {
    // Serve cached turn!
    const cachedTurns = getTurnsForSession(sessionId, 'main');
    const cached = cachedTurns[fork.currentTurnIndex];
    if (cached) {
      fork.currentTurnIndex++;
      broadcastToUI('turn_cached_hit', {
        sessionId,
        turnIndex: cached.turn_index,
        tokensSaved: cached.tokens
      });
      return reply.send(JSON.parse(cached.response_payload));
    }
  }

  // Forward request upstream
  const upstreamUrl = `${UPSTREAM_BASE_URL}/v1/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  for (const [name, value] of Object.entries(req.headers)) {
    const lowerName = name.toLowerCase();
    if (lowerName === 'authorization' || lowerName === 'openai-organization' || lowerName === 'openai-project' || lowerName === 'user-agent' || lowerName.startsWith('x-stainless-')) {
      headers[lowerName] = value;
    }
  }

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });

    const upstreamContentType = upstreamRes.headers.get('content-type') || '';
    let upstreamStreamText = null;
    let responseJson;
    if (streamingRequested && upstreamContentType.toLowerCase().includes('text/event-stream')) {
      upstreamStreamText = await upstreamRes.text();
      responseJson = parseChatCompletionStream(upstreamStreamText);
    } else {
      responseJson = await upstreamRes.json();
    }
    const choices = Array.isArray(responseJson.choices) ? responseJson.choices : [];
    const hasLegacyFunctionCall = choices.some((choice) => choice.message?.function_call);
    const rawToolCalls = choices.flatMap((choice) => choice.message?.tool_calls || []);
    const projectConfig = loadProjects();
    const activeProject = projectConfig.projects.find((project) => project.id === projectConfig.activeProjectId);
    const enforcementScope = activeProject ? {
      workspacePath: activeProject.workspacePath,
      allowedPaths: activeProject.allowedPaths,
      forbiddenPaths: activeProject.forbiddenPaths,
      allowedCommands: activeProject.allowedCommands
    } : null;
    const inspectedCalls = rawToolCalls.map((call) => {
      const inspection = inspectToolCall(call, enforcementScope);
      if (containsSensitiveValue(inspection.action)) {
        inspection.allowed = false;
        inspection.driftStatus = 'UNKNOWN';
        inspection.reason = 'Credential-like content detected in tool arguments; action withheld';
      }
      if (inspection.allowed && inspection.action.targetPath && !pathStaysInWorkspace(inspection.action.targetPath, enforcementScope?.workspacePath)) {
        inspection.allowed = false;
        inspection.driftStatus = 'UNKNOWN';
        inspection.reason = 'Workspace root is missing, path resolves outside it, or a symlink could not be validated';
      }
      return { call, inspection };
    });
    let deniedReason = hasLegacyFunctionCall ? 'Legacy function_call response format is unsupported' : null;
    for (const { call, inspection } of inspectedCalls) {
      if (!inspection.allowed) {
        const denial = { id: randomUUID(), sessionId, action: redactSensitive(inspection.action), risk: inspection.risk || 'UNKNOWN', reason: inspection.reason || 'Action is outside policy' };
        broadcastToUI('action_denied', denial);
        deniedReason = `AgentGDB denied a proposed tool call (${call.function?.name || 'unknown'}): ${denial.reason}`;
        break;
      }
    }
    // Do not request approvals for an otherwise allowed call if a sibling action
    // in the same upstream response is unsupported or outside the allowlist.
    if (!deniedReason) for (const { call, inspection } of inspectedCalls) {
      if (inspection.risk === 'MUTATING') {
        const id = randomUUID();
        const expiresAt = Date.now() + APPROVAL_TIMEOUT_MS;
        createApproval({ id, sessionId, action: redactSensitive(inspection.action), risk: inspection.risk, expiresAt });
        broadcastToUI('approval_pending', getApproval(id));
        const approved = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            expireApproval(id);
            resolve(false);
          }, APPROVAL_TIMEOUT_MS);
          const poll = setInterval(() => {
            const current = getApproval(id);
            if (!current || current.status !== 'PENDING') {
              clearTimeout(timer);
              clearInterval(poll);
              resolve(current?.status === 'APPROVED');
            }
          }, 200);
        });
        if (!approved) {
          deniedReason = `AgentGDB withheld mutating action ${call.function?.name} because approval was denied, expired, or interrupted.`;
          break;
        }
      }
    }
    if (deniedReason) {
      for (const choice of choices) {
        if (choice.message?.tool_calls) choice.message.tool_calls = [];
        if (choice.message?.function_call) delete choice.message.function_call;
        if (choice.message) choice.message.content = deniedReason;
      }
    }
    const latencyMs = Date.now() - startTime;
    const tokens = responseJson.usage?.total_tokens || 0;

    // Record turn in event store
    const turnId = randomUUID();
    const turns = getTurnsForSession(sessionId, fork ? fork.branchName : 'main');
    const turnIndex = turns.length + 1;

    // Extract tool calls if any
    const toolCalls = TRACE_CAPTURE ? redactSensitive(rawToolCalls) : rawToolCalls.map((call) => ({ id: call.id, type: call.type, function: { name: call.function?.name } }));

    recordTurn({
      id: turnId,
      session_id: sessionId,
      turn_index: turnIndex,
      parent_turn_id: turns.length > 0 ? turns[turns.length - 1].id : null,
      branch_name: fork ? fork.branchName : 'main',
      request_payload: TRACE_CAPTURE ? JSON.stringify(redactSensitive(req.body)) : null,
      response_payload: TRACE_CAPTURE ? JSON.stringify(redactSensitive(responseJson)) : null,
      tool_calls: JSON.stringify(toolCalls),
      tool_results: null,
      is_cached: 0,
      breakpoint_hit: shouldBreak ? 1 : 0,
      schema_version: 1,
      engine_version: '1.0.0',
      request_hash: TRACE_CAPTURE ? createHash('sha256').update(JSON.stringify(redactSensitive(req.body))).digest('hex') : null,
      response_hash: TRACE_CAPTURE ? createHash('sha256').update(JSON.stringify(redactSensitive(responseJson))).digest('hex') : null,
      tokens,
      latency_ms: latencyMs,
      created_at: Date.now()
    });

    broadcastToUI('turn_completed', {
      sessionId,
      turnIndex,
      model,
      tokens,
      latencyMs,
      toolCalls
    });

      if (upstreamStreamText && !deniedReason) return reply.status(upstreamRes.status).type('text/event-stream').header('cache-control', 'no-cache').send(upstreamStreamText);
      if (upstreamStreamText && deniedReason) return reply.status(upstreamRes.status).type('text/event-stream').header('cache-control', 'no-cache').send(deniedStreamMessage(responseJson, deniedReason));
      return reply.status(upstreamRes.status).send(responseJson);
  } catch (err) {
    reply.status(502).send({ error: 'AgentGDB failed upstream call', message: err.message });
  }
});

// Project Management APIs
fastify.get('/api/projects', async () => {
  return loadProjects();
});

fastify.post('/api/projects/switch', async (req) => {
  const { projectId } = req.body || {};
  let config;
  try { config = setActiveProject(projectId); } catch (error) { return { success: false, error: error.message }; }
  const target = config.projects.find(p => p.id === projectId);
  
  if (target && target.sessionPath) {
    if (activeLiveWatcher) activeLiveWatcher.stop();
    activeLiveWatcher = new LiveSessionStreamWatcher(
      target.sessionPath,
      {
        coreGoals: target.coreGoals || [],
        allowedPaths: target.allowedPaths || [],
        forbiddenPaths: target.forbiddenPaths || ['docs/', 'notes/', 'reports/']
      },
      (newStep) => broadcastToUI('live_step_added', newStep),
      (driftAlert) => broadcastToUI('live_drift_alert', driftAlert)
    );
    await activeLiveWatcher.start();
    broadcastToUI('project_switched', target);
  }
  return { success: true, activeProject: target };
});

fastify.post('/api/projects', async (req) => {
  const project = req.body;
  if (!project || typeof project.id !== 'string' || !project.id.trim() || typeof project.name !== 'string' || !project.name.trim()) {
    return { success: false, error: 'Project id and name are required.' };
  }
  if (project.sessionPath && (!path.isAbsolute(project.sessionPath) || !fs.existsSync(project.sessionPath))) {
    return { success: false, error: 'sessionPath must be an existing absolute path.' };
  }
  if (project.workspacePath && (!path.isAbsolute(project.workspacePath) || !fs.existsSync(project.workspacePath) || !fs.statSync(project.workspacePath).isDirectory())) {
    return { success: false, error: 'workspacePath must be an existing absolute directory.' };
  }
  for (const key of ['allowedPaths', 'forbiddenPaths', 'allowedCommands']) {
    if (project[key] !== undefined && (!Array.isArray(project[key]) || project[key].some((value) => typeof value !== 'string' || !value.trim()))) {
      return { success: false, error: `${key} must be an array of non-empty strings.` };
    }
  }
  if (Array.isArray(project.allowedPaths) && project.allowedPaths.length > 0 && !project.workspacePath) {
    return { success: false, error: 'workspacePath is required when configuring an enforcement allowlist.' };
  }
  const config = saveProject({ ...project, forbiddenPaths: project.forbiddenPaths || [], allowedCommands: project.allowedCommands || [] });
  return { success: true, config };
});

fastify.get('/api/live/active-goal', async () => {
  return activeLiveWatcher ? {
    activeGoal: activeLiveWatcher.activeGoal,
    isWatching: activeLiveWatcher.isWatching,
    path: activeLiveWatcher.filePath,
    driftStatus: activeLiveWatcher.driftStatus || 'UNKNOWN',
    enforcement: 'ADVISORY_ONLY'
  } : { activeGoal: null, isWatching: false, path: null };
});

fastify.post('/api/policy/check', async (req, reply) => {
  const targetPath = req.body?.targetPath;
  const decision = evaluateScopePolicy(targetPath, activeLiveWatcher?.scope, activeLiveWatcher?.isWatching === true);
  if (decision.driftStatus === 'UNKNOWN') return reply.code(503).send(decision);
  return decision;
});

fastify.post('/api/live/update-scope', async (req) => {
  const { coreGoals, forbiddenPaths } = req.body || {};
  if (!activeLiveWatcher) return { success: false, error: 'No active watcher' };
  if (coreGoals) activeLiveWatcher.scope.coreGoals = coreGoals;
  if (forbiddenPaths) activeLiveWatcher.scope.forbiddenPaths = forbiddenPaths;
  return { success: true, scope: activeLiveWatcher.scope };
});

const PORT = process.env.PORT || 9099;
fastify.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`\n======================================================`);
  console.log(`  AgentGDB Daemon listening on ${address}`);
  console.log(`  Open Debugger Web UI at: ${address}/index.html`);
  console.log(`  Proxy Target: ${UPSTREAM_BASE_URL}`);
  if (!process.env.AGENTGDB_APPROVAL_TOKEN) console.log(`  One-run approval token (enter in dashboard; do not share): ${APPROVAL_TOKEN}`);
  console.log(`======================================================\n`);
});
