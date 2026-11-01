/**
 * PushRelayService
 * F22: Dispatches real-time webhooks to Telegram, Discord, Slack, or NTFY
 * when an agent drifts, exceeds budget, or pauses for review during overnight 240h runs.
 */
export class PushRelayService {
  constructor(webhookUrl = null) {
    this.webhookUrl = webhookUrl || process.env.AGENTGDB_WEBHOOK_URL;
  }

  async dispatchAlert(alert) {
    if (!this.webhookUrl) {
      console.log(`[PushRelay] (Dry Run): ${alert.category} - ${alert.reason}`);
      return { status: 'mock_sent', alert };
    }

    const payload = {
      title: `🚨 AgentGDB Drift Alert: ${alert.category}`,
      message: `${alert.reason}\nTarget: ${alert.targetPath || 'N/A'}\nActive Goal: ${alert.activeGoal || 'N/A'}`,
      timestamp: new Date().toISOString()
    };

    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return { status: 'sent', statusCode: res.status };
    } catch (e) {
      console.error('[PushRelay Error]:', e.message);
      return { status: 'failed', error: e.message };
    }
  }
}
