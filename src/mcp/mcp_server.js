/**
 * Task 81: Model Context Protocol (MCP) Server Integration
 * Exposes AgentGDB tools to Cursor, Claude Desktop, Antigravity, and other agents.
 */
export class AgentGdbMcpServer {
  constructor(daemonUrl = 'http://localhost:9099') {
    this.daemonUrl = daemonUrl;
    this.tools = [
      {
        name: 'get_drift_status',
        description: 'Read the latest advisory scope status. This tool does not block agent actions.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'assert_scope_boundary',
        description: 'Check a proposed target against the configured advisory path policy; this does not enforce or block execution.',
        inputSchema: {
          type: 'object',
          properties: {
            targetPath: { type: 'string', description: 'File path or command to check' }
          },
          required: ['targetPath']
        }
      },
      {
        name: 'request_human_approval',
        description: 'Unavailable. Human approval is not implemented; this call fails explicitly.',
        inputSchema: {
          type: 'object',
          properties: {
            actionSummary: { type: 'string' },
            riskLevel: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] }
          },
          required: ['actionSummary']
        }
      }
    ];
  }

  async handleMcpToolCall(toolName, args = {}) {
    if (toolName === 'get_drift_status') {
      let data;
      try {
        const res = await fetch(`${this.daemonUrl}/api/live/active-goal`);
        if (!res.ok) throw new Error(`status endpoint returned ${res.status}`);
        data = await res.json();
      } catch (error) {
        data = { activeGoal: null, isWatching: false, driftStatus: 'UNKNOWN', statusError: error.message };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            activeGoal: data.activeGoal,
            driftStatus: data.driftStatus || 'UNKNOWN',
            monitoringActive: data.isWatching === true,
            enforcement: 'ADVISORY_ONLY',
            statusError: data.statusError
          }, null, 2)
        }]
      };
    }

    if (toolName === 'assert_scope_boundary') {
      const target = args.targetPath;
      let decision;
      try {
        const res = await fetch(`${this.daemonUrl}/api/policy/check`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ targetPath: target })
        });
        decision = await res.json();
        if (!res.ok) decision.allowed = false;
      } catch {
        decision = { targetPath: target, allowed: false, driftStatus: 'UNKNOWN', reason: 'Policy service unavailable; fail-closed advisory response.' };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(decision, null, 2)
        }]
      };
    }

    if (toolName === 'request_human_approval') {
      throw new Error('Human approval workflow is not implemented; refusing to imply approval was requested or granted.');
    }

    throw new Error(`Unknown MCP Tool: ${toolName}`);
  }
}
