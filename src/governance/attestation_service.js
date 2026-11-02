import crypto from 'crypto';

/**
 * Creates a hash-linked record and a descriptive session summary. These
 * outputs do not verify identity, scope compliance, or execution safety.
 */
export class AttestationAndPrSummaryService {
  static generateAttestationLedger(session) {
    const turns = session.turns || [];
    let previousHash = '0000000000000000000000000000000000000000000000000000000000000000';
    
    const blocks = turns.map((t) => {
      const parentHash = previousHash;
      const dataString = `${t.id}:${t.turn_index}:${t.tool_calls || ''}:${t.tool_results || ''}:${parentHash}`;
      const hash = crypto.createHash('sha256').update(dataString).digest('hex');
      previousHash = hash;
      return {
        turnIndex: t.turn_index,
        timestamp: t.created_at,
        hash,
        previousHash: parentHash,
        integrity: 'HASHED_NOT_VERIFIED'
      };
    });

    return {
      sessionId: session.id,
      generatedAt: new Date().toISOString(),
      chainHead: previousHash,
      blocks
    };
  }

  static generatePrSummaryMarkdown(session, metrics = {}) {
    const totalSteps = metrics.totalSteps ?? (session.turns ? session.turns.length : 0);
    const inScope = metrics.inScopeSteps ?? null;
    const drifts = metrics.totalDriftSteps ?? null;
    const duration = metrics.elapsedHours ?? 0;
    const driftPercentage = totalSteps > 0 && drifts !== null ? Math.round((drifts / totalSteps) * 100) : null;

    return `
## AgentGDB session summary (unverified)
*Descriptive values from the supplied session data. This summary does not prove safe or in-scope execution.*

| Metric | Supplied value |
| :--- | :--- | :--- |
| **Active goal** | \`${metrics.activeGoal || 'Not provided'}\` |
| **Elapsed time** | \`${duration} hours\` |
| **Total steps** | \`${totalSteps}\` |
| **Steps marked in scope** | \`${inScope === null ? 'Not provided' : inScope}\` |
| **Steps marked as drift** | \`${drifts === null ? 'Not provided' : drifts}\` |

Observed drift count: ${drifts === null ? 'not provided' : `${drifts} of ${totalSteps} steps (${driftPercentage}%)`}. This is an advisory observation, not an enforcement or certification result.
`;
  }
}
