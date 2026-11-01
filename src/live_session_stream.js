import fs from 'fs';
import readline from 'readline';

/**
 * LiveSessionStreamWatcher
 * Continuously polls / watches an active session transcript file (Antigravity or Codex).
 * Automatically extracts the active user goal and streams new steps in real-time over WebSocket.
 */
export class LiveSessionStreamWatcher {
  constructor(filePath, scope = {}, onNewStep = () => {}, onDriftAlert = () => {}) {
    this.filePath = filePath;
    this.scope = {
      coreGoals: scope.coreGoals || [],
      allowedPaths: scope.allowedPaths || [],
      forbiddenPaths: scope.forbiddenPaths || ['docs/', 'notes/', 'reports/', '.github/workflows/']
    };
    this.onNewStep = onNewStep;
    this.onDriftAlert = onDriftAlert;
    this.lastProcessedLine = 0;
    this.sessionStartTime = null;
    this.activeGoal = 'Discovering active goal from agent trajectory...';
    this.isWatching = false;
    this.watcher = null;
  }

  // Extract the latest active user goal from conversation
  extractActiveGoal(lineObj) {
    if (lineObj.source === 'USER_EXPLICIT' && lineObj.content) {
      const match = lineObj.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
      if (match && match[1]) {
        return match[1].trim().replace(/\n+/g, ' ');
      }
      return lineObj.content.slice(0, 200).trim();
    }
    return null;
  }

  async start() {
    this.isWatching = true;
    await this.scanInitialFile();

    // Set up file change watcher
    if (fs.existsSync(this.filePath)) {
      this.watcher = fs.watch(this.filePath, async (eventType) => {
        if (eventType === 'change') {
          await this.readNewLines();
        }
      });
    }

    // Also set fallback interval for streaming JSONL flushes
    this.intervalId = setInterval(() => {
      this.readNewLines();
    }, 1500);
  }

  stop() {
    this.isWatching = false;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async scanInitialFile() {
    if (!fs.existsSync(this.filePath)) return;

    const fileStream = fs.createReadStream(this.filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let lineIndex = 0;
    for await (const line of rl) {
      lineIndex++;
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line);
        const goalCandidate = this.extractActiveGoal(raw);
        if (goalCandidate) {
          this.activeGoal = goalCandidate;
        }
        if (!this.sessionStartTime && raw.created_at) {
          this.sessionStartTime = new Date(raw.created_at).getTime();
        }
      } catch (e) {}
    }

    this.lastProcessedLine = lineIndex;
  }

  async readNewLines() {
    if (!fs.existsSync(this.filePath)) return;

    const fileStream = fs.createReadStream(this.filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let currentLine = 0;
    for await (const line of rl) {
      currentLine++;
      if (currentLine <= this.lastProcessedLine) continue;

      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line);
        const goalCandidate = this.extractActiveGoal(raw);
        if (goalCandidate) {
          this.activeGoal = goalCandidate;
        }

        const normalized = this.normalizeStep(raw, currentLine);
        if (normalized) {
          const driftEvaluation = this.checkDrift(normalized);
          normalized.drift = driftEvaluation;

          this.onNewStep({
            ...normalized,
            activeGoal: this.activeGoal
          });

          if (driftEvaluation.isDrift) {
            this.onDriftAlert({
              step: normalized.stepIndex,
              driftCategory: driftEvaluation.category,
              driftReason: driftEvaluation.reason,
              activeGoal: this.activeGoal,
              tool: normalized.toolName,
              target: normalized.targetPath,
              timestamp: normalized.timestamp
            });
          }
        }
      } catch (e) {}
    }

    this.lastProcessedLine = currentLine;
  }

  normalizeStep(raw, lineIndex) {
    // Antigravity format
    if (raw.step_index !== undefined) {
      const toolCalls = (raw.tool_calls || []).map(tc => {
        let args = tc.args || {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch (e) {}
        }
        return {
          name: tc.name,
          args,
          targetPath: args.Path || args.path || args.CommandLine || null
        };
      });

      const primaryTool = toolCalls[0] || {};
      const now = new Date(raw.created_at || Date.now()).getTime();
      const elapsedHours = this.sessionStartTime 
        ? Math.max(0, Math.round(((now - this.sessionStartTime) / (1000 * 60 * 60)) * 10) / 10)
        : 0;

      return {
        stepIndex: raw.step_index,
        timestamp: raw.created_at || new Date().toISOString(),
        elapsedHours,
        source: raw.source || 'AGENT',
        type: raw.type || 'STEP',
        toolName: primaryTool.name || raw.type,
        targetPath: primaryTool.targetPath || '',
        args: primaryTool.args || {},
        content: raw.content ? raw.content.slice(0, 300) : ''
      };
    }

    return null;
  }

  checkDrift(step) {
    const target = (step.targetPath || '').toLowerCase();
    
    // Check forbidden paths
    for (const forbidden of this.scope.forbiddenPaths) {
      if (target.includes(forbidden.toLowerCase())) {
        return {
          isDrift: true,
          category: 'SCOPE_EXPANSION_DRIFT',
          reason: `Agent accessed forbidden boundary path: "${step.targetPath}" which is outside declared scope!`
        };
      }
    }

    // Check repetitive journaling
    if (target.endsWith('.md') && !target.includes('skill.md')) {
      return {
        isDrift: true,
        category: 'DOCS_JOURNALING_DRIFT',
        reason: `Agent is writing documentation notes ("${step.targetPath}") instead of executing functional code.`
      };
    }

    return {
      isDrift: false,
      category: 'IN_SCOPE',
      reason: 'Action focused on active goal'
    };
  }
}
