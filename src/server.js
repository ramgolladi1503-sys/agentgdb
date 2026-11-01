import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fastify = Fastify({ logger: false });
await fastify.register(cors, { origin: '*' });
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

// Upstream target (default to OpenAI standard endpoint, can be overridden per request or via env)
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || 'https://api.openai.com';

// Broadcast helper to connected UI clients
const uiClients = new Set();

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
  return getTurnsForSession(req.params.id, branch);
});

// Live Local Agent Session Watcher API (Antigravity, Codex, Claude Code, Cursor)
fastify.post('/api/local/watch', async (req) => {
  const { sessionPath, source, coreGoals, allowedPaths, forbiddenPaths } = req.body || {};
  
  let targetPath = sessionPath;
  if (!targetPath) {
    if (source === 'local_codex') {
      targetPath = `${process.env.HOME}/.codex/sessions/2026/11/01/rollout-2026-11-01T11-11-20-01a195a0-6b5a-71c3-843a-bd3ad57ec0fa.jsonl`;
    } else {
      targetPath = `${process.env.HOME}/.gemini/antigravity/brain/554eb738-91a4-4f63-9ce5-90279b2400b3/.system_generated/logs/transcript.jsonl`;
    }
  }
  
  const watcher = new UniversalAgentWatcher({
    definedScope: {
      coreGoals: coreGoals || ['PostgreSQL Database Cutover and Production Readiness'],
      allowedPaths: allowedPaths || ['backend/app/postgres*', 'backend/tests/test_postgres*'],
      forbiddenPaths: forbiddenPaths || ['docs/', 'notes/', 'reports/', '.github/workflows/', 'mobile/android/']
    }
  });

  return watcher.parseSessionTranscript(targetPath);
});

fastify.get('/api/breakpoints', async () => {
  return getBreakpoints();
});

// Scope & Git Code Drift Replay API
fastify.get('/api/pr/drift', async (req) => {
  const repoPath = req.query.repoPath || '/Users/madhuram/aixion-control-tower';
  const prNumber = req.query.pr || '204';
  const definedScope = req.query.scope || 'PostgreSQL Database Migration and Production Readiness Cutover';
  const limit = parseInt(req.query.limit || '40', 10);

  const baseRef = prNumber === '207' ? '5a55b23' : '5a55b23';
  const headRef = `pr-${prNumber}`;

  return analyzePullRequestDrift(repoPath, baseRef, headRef, definedScope, limit);
});

fastify.get('/api/pr/commit-diff', async (req) => {
  const repoPath = req.query.repoPath || '/Users/madhuram/aixion-control-tower';
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
    const toolCalls = responseJson.choices?.[0]?.message?.tool_calls || [];

    recordTurn({
      id: turnId,
      session_id: sessionId,
      turn_index: turnIndex,
      parent_turn_id: turns.length > 0 ? turns[turns.length - 1].id : null,
      branch_name: fork ? fork.branchName : 'main',
      request_payload: JSON.stringify(req.body),
      response_payload: JSON.stringify(responseJson),
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

// Start Live Continuous Background Watcher
const liveTranscriptPath = `${process.env.HOME}/.gemini/antigravity/brain/554eb738-91a4-4f63-9ce5-90279b2400b3/.system_generated/logs/transcript.jsonl`;
let activeLiveWatcher = new LiveSessionStreamWatcher(
  liveTranscriptPath,
  {
    coreGoals: ['Build and monitor live running drift watcher for Antigravity & Codex'],
    forbiddenPaths: ['tradebot', 'docs/verification/', '.github/workflows/']
  },
  (newStep) => {
    broadcastToUI('live_step_added', newStep);
  },
  (driftAlert) => {
    broadcastToUI('live_drift_alert', driftAlert);
  }
);
activeLiveWatcher.start();

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
    activeLiveWatcher.start();
    broadcastToUI('project_switched', target);
  }
  return { success: true, activeProject: target };
});

fastify.post('/api/projects', async (req) => {
  const project = req.body;
  const config = saveProject(project);
  return { success: true, config };
});

fastify.get('/api/live/active-goal', async () => {
  return {
    activeGoal: activeLiveWatcher.activeGoal,
    isWatching: activeLiveWatcher.isWatching,
    path: activeLiveWatcher.filePath
  };
});

fastify.post('/api/live/update-scope', async (req) => {
  const { coreGoals, forbiddenPaths } = req.body || {};
  if (coreGoals) activeLiveWatcher.scope.coreGoals = coreGoals;
  if (forbiddenPaths) activeLiveWatcher.scope.forbiddenPaths = forbiddenPaths;
  return { success: true, scope: activeLiveWatcher.scope };
});

const PORT = process.env.PORT || 9099;
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
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
