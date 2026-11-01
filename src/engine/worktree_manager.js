import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

/**
 * Task 37: Git Worktree Branch Isolation
 * Automatically provisions an isolated git worktree for each fork branch,
 * so time-travel branches can run code without touching the developer's working directory.
 */
export class GitWorktreeManager {
  constructor(repoRoot = process.cwd()) {
    this.repoRoot = repoRoot;
    this.worktreeBase = path.join(repoRoot, '.agentgdb', 'worktrees');
    if (!fs.existsSync(this.worktreeBase)) {
      fs.mkdirSync(this.worktreeBase, { recursive: true });
    }
  }

  createWorktreeForFork(branchName, fromCommit = 'HEAD') {
    const targetDir = path.join(this.worktreeBase, branchName);
    if (fs.existsSync(targetDir)) {
      return { path: targetDir, status: 'EXISTS' };
    }

    try {
      execSync(`git worktree add -b "${branchName}" "${targetDir}" ${fromCommit}`, {
        cwd: this.repoRoot,
        stdio: 'pipe'
      });
      return { path: targetDir, status: 'CREATED', branchName };
    } catch (e) {
      // Fallback if branch exists
      try {
        execSync(`git worktree add "${targetDir}" "${branchName}"`, {
          cwd: this.repoRoot,
          stdio: 'pipe'
        });
        return { path: targetDir, status: 'ATTACHED', branchName };
      } catch (err) {
        return { path: targetDir, status: 'ERROR', error: err.message };
      }
    }
  }

  removeWorktree(branchName) {
    const targetDir = path.join(this.worktreeBase, branchName);
    try {
      execSync(`git worktree remove --force "${targetDir}"`, {
        cwd: this.repoRoot,
        stdio: 'pipe'
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  listWorktrees() {
    try {
      const output = execSync('git worktree list', { cwd: this.repoRoot, encoding: 'utf-8' });
      return output.trim().split('\n').map(line => {
        const parts = line.split(/\s+/);
        return { path: parts[0], commit: parts[1], branch: parts[2] || 'detached' };
      });
    } catch (e) {
      return [];
    }
  }
}
