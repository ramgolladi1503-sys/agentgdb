import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, timingSafeEqual } from 'crypto';
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
  getBreakpoints,
  addBreakpoint,
  removeBreakpoint
} from './db.js';
import { replayManager } from './replayer.js';
import { analyzePullRequestDrift, getCommitDiff } from './git_drift_analyzer.js';
import { UniversalAgentWatcher } from './universal_watcher.js';
import { LiveSessionStreamWatcher } from './live_session_stream.js';
import { loadProjects, saveProject, setActiveProject } from './project_registry.js';
import { applyTraceRetention, purgeTurnsBefore } from './db.js';
import { evaluateScopePolicy } from './security/scope_policy.js';

// Upstream target (default to OpenAI standard endpoint, can be overridden via env)
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || 'https://api.openai.com';
const TRACE_CAPTURE = process.env.AGENTGDB_TRACE_CAPTURE === 'true';
const HOST = process.env.HOST || '127.0.0.1';
applyTraceRetention();

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
  
  const watcher = new UniversalAgentWatcher({
    definedScope: {
      coreGoals: coreGoals || [],
      allowedPaths: allowedPaths || [],
      forbiddenPaths: forbiddenPaths || []
    }
  });

  const parsed = await watcher.parseSessionTranscript(targetPath);
  if (activeLiveWatcher) activeLiveWatcher.stop();
  activeLiveWatcher = new LiveSessionStreamWatcher(targetPath, watcher.definedScope,
    (step) => broadcastToUI('live_step_added', step),
    (alert) => broadcastToUI('live_drift_alert', alert));
  await activeLiveWatcher.start();
  for (const event of parsed.timeline || []) broadcastToUI('live_step_added', event);
  return parsed;
});

fastify.get('/api/breakpoints', async () => {
  return getBreakpoints();
});

fastify.delete('/api/traces', async (req, reply) => {
  const before = Number(req.query.before);
  if (!Number.isFinite(before)) return reply.code(400).send({ error: 'A numeric before timestamp is required' });
  return { deletedTurns: purgeTurnsBefore(before) };
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
  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['content-length'];

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': req.headers['authorization'] || ''
      },
      body: JSON.stringify(req.body)
    });

    const responseJson = await upstreamRes.json();
    const latencyMs = Date.now() - startTime;
    const tokens = responseJson.usage?.total_tokens || 0;

    // Record turn in event store
    const turnId = randomUUID();
    const turns = getTurnsForSession(sessionId, fork ? fork.branchName : 'main');
    const turnIndex = turns.length + 1;

    // Extract tool calls if any
    const rawToolCalls = responseJson.choices?.[0]?.message?.tool_calls || [];
    const toolCalls = TRACE_CAPTURE ? rawToolCalls : rawToolCalls.map((call) => ({ id: call.id, type: call.type, function: { name: call.function?.name } }));

    recordTurn({
      id: turnId,
      session_id: sessionId,
      turn_index: turnIndex,
      parent_turn_id: turns.length > 0 ? turns[turns.length - 1].id : null,
      branch_name: fork ? fork.branchName : 'main',
      request_payload: TRACE_CAPTURE ? JSON.stringify(req.body) : null,
      response_payload: TRACE_CAPTURE ? JSON.stringify(responseJson) : null,
      tool_calls: JSON.stringify(toolCalls),
      tool_results: null,
      is_cached: 0,
      breakpoint_hit: shouldBreak ? 1 : 0,
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
  const config = setActiveProject(projectId);
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
  const config = saveProject(project);
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
  console.log(`======================================================\n`);
});
