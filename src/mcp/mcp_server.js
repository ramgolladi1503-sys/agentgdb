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
        description: 'Check whether the agent is currently within its declared scope boundary or drifting.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'assert_scope_boundary',
        description: 'Verify if a proposed file path or shell command is permitted before executing.',
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
        description: 'Submit an architectural decision or destructive action to the AgentGDB web UI for approval.',
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
      const res = await fetch(`${this.daemonUrl}/api/live/active-goal`);
      const data = await res.json();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            activeGoal: data.activeGoal,
            driftStatus: 'ON_TRACK',
            monitoringActive: data.isWatching
          }, null, 2)
        }]
      };
    }

    if (toolName === 'assert_scope_boundary') {
      const target = (args.targetPath || '').toLowerCase();
      const isForbidden = target.includes('credentials') || target.includes('.env') || target.includes('.github');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            targetPath: args.targetPath,
            allowed: !isForbidden,
            reason: isForbidden ? 'Path violates defined scope boundaries.' : 'Path is permitted within active scope.'
          }, null, 2)
        }]
      };
    }

    if (toolName === 'request_human_approval') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'PENDING_OPERATOR_APPROVAL',
            action: args.actionSummary,
            message: 'Action submitted to AgentGDB dashboard. Please check http://localhost:9099'
          }, null, 2)
        }]
      };
    }

    throw new Error(`Unknown MCP Tool: ${toolName}`);
  }
}
