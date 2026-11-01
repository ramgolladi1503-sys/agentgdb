import fs from 'fs';
import path from 'path';

/**
 * InvariantEngine
 * Evaluates F01-F05 hard gates:
 * - Active auto-freeze
 * - Semantic scope bounds
 * - Blast radius traps
 * - Stagnation loops
 * - Token budget ceilings
 */
export class InvariantEngine {
  constructor(options = {}) {
    this.tokenBudget = options.tokenBudget || 150000;
    this.maxConsecutiveReads = options.maxConsecutiveReads || 4;
    this.maxConsecutiveDocs = options.maxConsecutiveDocs || 2;
    this.allowedPaths = options.allowedPaths || [];
    this.forbiddenPaths = options.forbiddenPaths || ['docs/', 'reports/', '.github/workflows/'];
    
    this.consecutiveReads = 0;
    this.consecutiveDocs = 0;
    this.totalTokensAccumulated = 0;
    this.history = [];
  }

  evaluateStep(step) {
    this.history.push(step);
    if (step.tokens) this.totalTokensAccumulated += step.tokens;

    const toolName = (step.toolName || '').toLowerCase();
    const target = (step.targetPath || '').toLowerCase();

    // 1. Token budget ceiling
    if (this.totalTokensAccumulated > this.tokenBudget) {
      return {
        halt: true,
        category: 'BUDGET_EXCEEDED_HALT',
        reason: `Accumulated ${this.totalTokensAccumulated} tokens, exceeding ceiling of ${this.tokenBudget}. Halting agent run.`
      };
    }

    // 2. Blast radius / Forbidden path
    for (const forbidden of this.forbiddenPaths) {
      if (target.includes(forbidden.toLowerCase())) {
        return {
          halt: true,
          category: 'BLAST_RADIUS_VIOLATION',
          reason: `Agent attempted modification of forbidden path: "${step.targetPath}". Physical gate triggered.`
        };
      }
    }

    // 3. Stagnation / spinning wheel
    const isRead = toolName.includes('read') || toolName.includes('find') || toolName.includes('list') || toolName.includes('search');
    if (isRead) {
      this.consecutiveReads++;
      if (this.consecutiveReads >= this.maxConsecutiveReads) {
        return {
          halt: true,
          category: 'STAGNATION_LOOP_HALT',
          reason: `Agent spun in ${this.consecutiveReads} consecutive read actions without forward implementation.`
        };
      }
    } else {
      this.consecutiveReads = 0;
    }

    // 4. Docs rabbit-hole
    const isDoc = target.endsWith('.md') || target.endsWith('.txt') || target.includes('/docs/');
    if (isDoc) {
      this.consecutiveDocs++;
      if (this.consecutiveDocs >= this.maxConsecutiveDocs) {
        return {
          halt: true,
          category: 'DOCS_JOURNALING_HALT',
          reason: `Agent drifted into writing documentation for ${this.consecutiveDocs} consecutive steps.`
        };
      }
    } else {
      this.consecutiveDocs = 0;
    }

    return { halt: false, category: 'IN_SCOPE', reason: 'Aligned with defined scope.' };
  }
}
