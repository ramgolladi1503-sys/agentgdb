import { v4 as uuidv4 } from 'crypto';

class ReplayManager {
  constructor() {
    this.activeForks = new Map(); // sessionId -> forkConfig
    this.pausedSessions = new Map(); // sessionId -> { resolve, reject, turnData }
  }

  // Set up a fork branch from a specific turn
  createFork(sessionId, fromTurnIndex, branchName, mockOverrides = {}) {
    this.activeForks.set(sessionId, {
      fromTurnIndex,
      branchName,
      mockOverrides,
      currentTurnIndex: 0
    });
  }

  isForkActive(sessionId) {
    return this.activeForks.has(sessionId);
  }

  getFork(sessionId) {
    return this.activeForks.get(sessionId);
  }

  clearFork(sessionId) {
    this.activeForks.delete(sessionId);
  }

  // Pause an agent execution for human inspection / breakpoint
  pauseForInspection(sessionId, turnData) {
    return new Promise((resolve, reject) => {
      this.pausedSessions.set(sessionId, { resolve, reject, turnData, pausedAt: Date.now() });
    });
  }

  isPaused(sessionId) {
    return this.pausedSessions.has(sessionId);
  }

  getPausedState(sessionId) {
    return this.pausedSessions.get(sessionId);
  }

  // Resume a paused session (accept modified tool output or approval)
  resume(sessionId, modifiedPayload = null) {
    if (!this.pausedSessions.has(sessionId)) {
      return false;
    }
    const { resolve } = this.pausedSessions.get(sessionId);
    this.pausedSessions.delete(sessionId);
    resolve({ action: 'resume', modifiedPayload });
    return true;
  }

  abort(sessionId, reason = 'Aborted by user in AgentGDB') {
    if (!this.pausedSessions.has(sessionId)) {
      return false;
    }
    const { reject } = this.pausedSessions.get(sessionId);
    this.pausedSessions.delete(sessionId);
    reject(new Error(reason));
    return true;
  }
}

export const replayManager = new ReplayManager();
