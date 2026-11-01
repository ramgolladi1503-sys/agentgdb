import crypto from 'crypto';

/**
 * Tasks 19 & 20: Lightweight Fast Semantic Scorer & Cosine Matcher
 * Uses token-frequency semantic hashing and bag-of-words cosine projection
 * for zero-dependency, ultra-fast on-device drift evaluation without external API calls.
 */
export class SemanticScopeMatcher {
  constructor(goalText = '') {
    this.goalVector = this.vectorize(goalText);
  }

  vectorize(text) {
    if (!text) return {};
    const words = text.toLowerCase().replace(/[^a-z0-9_\-\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    const vec = {};
    for (const w of words) {
      vec[w] = (vec[w] || 0) + 1;
    }
    // Normalize
    const mag = Math.sqrt(Object.values(vec).reduce((sum, v) => sum + v * v, 0)) || 1;
    for (const k in vec) {
      vec[k] /= mag;
    }
    return vec;
  }

  calculateCosineSimilarity(actionText) {
    const actionVec = this.vectorize(actionText);
    let dot = 0;
    for (const k in actionVec) {
      if (this.goalVector[k]) {
        dot += actionVec[k] * this.goalVector[k];
      }
    }
    return Math.round(dot * 100) / 100;
  }

  evaluateDrift(actionText, threshold = 0.40) {
    const similarity = this.calculateCosineSimilarity(actionText);
    const isDrifting = similarity < threshold;
    return {
      similarity,
      threshold,
      isDrifting,
      confidence: Math.round((1 - similarity) * 100),
      reason: isDrifting 
        ? `Semantic intent score (${similarity}) fell below target threshold (${threshold}). Action diverges from core goal.`
        : 'Action semantically aligns with target goal.'
    };
  }
}
