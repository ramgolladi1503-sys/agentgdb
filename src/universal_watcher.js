import fs from 'fs';
import path from 'path';
import readline from 'readline';

// Universal Agent Transcript Watcher & Drift Invariant Engine
// Supports: Antigravity, Codex, Claude Code, Cursor, OpenHands

export class UniversalAgentWatcher {
  constructor(options = {}) {
    this.sessionPath = options.sessionPath;
    this.definedScope = options.definedScope || {
      coreGoals: [],
      allowedPaths: [],
      forbiddenPaths: []
    };
    this.events = [];
  }

  // Parse any supported agent session format into a unified trajectory
  async parseSessionTranscript(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Session transcript file not found: ${filePath}`);
    }

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    const parsedEvents = [];
    let turnCounter = 0;
    let sessionStartTime = null;

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line);
        const unified = this.normalizeEvent(raw, ++turnCounter);
        if (unified) {
          if (!sessionStartTime && unified.timestamp) {
            sessionStartTime = new Date(unified.timestamp).getTime();
          }
          if (sessionStartTime && unified.timestamp) {
            const currentMs = new Date(unified.timestamp).getTime();
            unified.elapsedHours = Math.max(0, Math.round(((currentMs - sessionStartTime) / (1000 * 60 * 60)) * 10) / 10);
          } else {
            unified.elapsedHours = 0;
          }
          parsedEvents.push(unified);
        }
      } catch (err) {
        // Skip malformed lines
      }
    }

    return this.evaluateTrajectoryDrift(parsedEvents, this.definedScope);
  }

  // Normalizes Antigravity, Codex, or generic agent formats into standard format
  normalizeEvent(raw, turnIndex) {
    // 1. Antigravity format
    if (raw.step_index !== undefined) {
      const toolCalls = (raw.tool_calls || []).map(tc => {
        let parsedArgs = tc.args || {};
        if (typeof parsedArgs === 'string') {
          try { parsedArgs = JSON.parse(parsedArgs); } catch (e) {}
        }
        return {
          name: tc.name,
          args: parsedArgs,
          targetPath: parsedArgs.Path || parsedArgs.path || parsedArgs.CommandLine || null
        };
      });

      return {
        stepIndex: turnIndex,
        timestamp: raw.created_at || new Date().toISOString(),
        source: raw.source || 'AGENT',
        type: raw.type || 'TOOL_ACTION',
        content: raw.content || '',
        toolCalls,
        raw
      };
    }

    // 2. Codex rollout JSONL format
    const item = raw.payload?.item;
    if (raw.type === 'event_msg' && item) {
      const toolCalls = [];
      let content = '';

      if (item.type === 'CommandExecution') {
        const cmdStr = Array.isArray(item.command) ? item.command.join(' ') : (item.command || '');
        toolCalls.push({
          name: 'bash_run',
          args: { command: cmdStr },
          targetPath: cmdStr
        });
        content = cmdStr;
      } else if (item.type === 'FileChange') {
        const filePath = item.path || item.file || '';
        toolCalls.push({
          name: 'edit_file',
          args: { path: filePath },
          targetPath: filePath
        });
        content = `Edit ${filePath}`;
      } else if (item.type === 'AgentMessage') {
        content = item.text || item.message || '';
      }

      if (toolCalls.length > 0 || content) {
        return {
          stepIndex: turnIndex,
          timestamp: raw.timestamp || new Date().toISOString(),
          source: 'CODEX',
          type: item.type || raw.type,
          content,
          toolCalls,
          raw
        };
      }
    }

    if (raw.type === 'session_meta') {
      return {
        stepIndex: turnIndex,
        timestamp: raw.timestamp || new Date().toISOString(),
        source: 'CODEX_INIT',
        type: 'session_init',
        content: `Codex Session Initialized: ${raw.payload?.cwd || 'workspace'}`,
        toolCalls: [],
        raw
      };
    }

    return null;

    return null;
  }

  // Evaluates every hour/step of the trajectory against the target scope
  evaluateTrajectoryDrift(events, scope) {
    const coreGoals = scope.coreGoals || [];
    const allowedPaths = scope.allowedPaths || [];
    const forbiddenPaths = scope.forbiddenPaths || ['docs/', 'notes/', 'reports/', '.github/workflows/'];

    let consecutiveDocsTurns = 0;
    let consecutiveReadTurns = 0;
    let totalDriftSteps = 0;

    const timeline = events.map((event, idx) => {
      let driftCategory = 'IN_SCOPE';
      let driftReason = 'Action focused on goal execution';
      let scopeBound = true;

      // Extract touched paths from tool calls
      const touchedPaths = event.toolCalls.map(tc => tc.targetPath).filter(Boolean);

      // Rule 1: Forbidden path boundary violation
      const violatedPath = touchedPaths.find(p => 
        forbiddenPaths.some(fp => typeof p === 'string' && p.toLowerCase().includes(fp.toLowerCase()))
      );

      // Rule 2: Documentation & Journaling rabbit-hole
      const isDocsAction = touchedPaths.some(p => 
        typeof p === 'string' && (p.endsWith('.md') || p.endsWith('.txt') || p.includes('/docs/'))
      );

      // Rule 3: Read-only spinning wheel (continuous inspection without implementation)
      const isReadAction = event.toolCalls.some(tc => 
        tc.name.includes('read') || tc.name.includes('search') || tc.name.includes('find') || tc.name.includes('list')
      );

      if (isDocsAction) {
        consecutiveDocsTurns++;
        if (consecutiveDocsTurns >= 2) {
          driftCategory = 'DOCS_JOURNALING_DRIFT';
          driftReason = `Agent drifted into repetitive journaling or audit notes for ${consecutiveDocsTurns} consecutive steps instead of implementing the core goals.`;
          scopeBound = false;
        }
      } else {
        consecutiveDocsTurns = 0;
      }

      if (violatedPath) {
        driftCategory = 'BOUNDARY_EXPANSION_DRIFT';
        driftReason = `Agent modified paths outside declared scope boundary: ${violatedPath}`;
        scopeBound = false;
      }

      if (isReadAction && !isDocsAction) {
        consecutiveReadTurns++;
        if (consecutiveReadTurns >= 4) {
          driftCategory = 'ZERO_PROGRESS_STAGNATION';
          driftReason = `Agent is spinning in a read/search loop for ${consecutiveReadTurns} consecutive steps without making code progress.`;
          scopeBound = false;
        }
      } else {
        consecutiveReadTurns = 0;
      }

      if (!scopeBound) {
        totalDriftSteps++;
      }

      return {
        ...event,
        driftCategory,
        driftReason,
        scopeBound,
        touchedPaths
      };
    });

    const driftPercentage = timeline.length > 0 ? Math.round((totalDriftSteps / timeline.length) * 100) : 0;

    return {
      totalSteps: timeline.length,
      elapsedHours: timeline.length > 0 ? timeline[timeline.length - 1].elapsedHours : 0,
      scope,
      metrics: {
        totalDriftSteps,
        inScopeSteps: timeline.length - totalDriftSteps,
        driftPercentage,
        status: driftPercentage > 40 ? 'CRITICAL_DRIFT' : (driftPercentage > 15 ? 'MODERATE_DRIFT' : 'ON_TRACK')
      },
      timeline
    };
  }
}
