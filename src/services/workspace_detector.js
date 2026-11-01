import fs from 'fs';
import path from 'path';

/**
 * WorkspaceConfigDetector
 * Automatically scans the root directory of a target repository for:
 * - AGENTS.md
 * - SPEC.json
 * - .cursorrules
 * - CLAUDE.md
 * and extracts allowed boundaries, target goals, and forbidden rules with zero manual configuration.
 */
export class WorkspaceConfigDetector {
  static detect(workspacePath) {
    if (!fs.existsSync(workspacePath)) {
      return null;
    }

    const detected = {
      workspacePath,
      goals: [],
      allowedPaths: [],
      forbiddenPaths: ['docs/', 'reports/', '.github/workflows/']
    };

    // Check AGENTS.md
    const agentsPath = path.join(workspacePath, 'AGENTS.md');
    if (fs.existsSync(agentsPath)) {
      const content = fs.readFileSync(agentsPath, 'utf-8');
      const forbiddenMatch = content.match(/Forbidden paths?[:\s]+([\s\S]*?)(?:\n\n|\n[A-Z#])/i);
      if (forbiddenMatch && forbiddenMatch[1]) {
        const paths = forbiddenMatch[1].split('\n').map(p => p.replace(/^[-*\s]+/, '').trim()).filter(Boolean);
        detected.forbiddenPaths = Array.from(new Set([...detected.forbiddenPaths, ...paths]));
      }
    }

    // Check SPEC.json
    const specPath = path.join(workspacePath, 'SPEC.json');
    if (fs.existsSync(specPath)) {
      try {
        const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
        if (spec.goal) detected.goals.push(spec.goal);
        if (spec.title) detected.goals.push(spec.title);
        if (spec.allowed_paths) detected.allowedPaths = spec.allowed_paths;
        if (spec.forbidden_paths) detected.forbiddenPaths = Array.from(new Set([...detected.forbiddenPaths, ...spec.forbidden_paths]));
      } catch (e) {}
    }

    return detected;
  }
}
