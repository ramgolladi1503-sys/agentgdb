import { execSync } from 'child_process';

export function analyzePullRequestDrift(repoPath, baseRef, headRef, definedScope, limit = 50) {
  // 1. Get commits in range
  const logCmd = `git log ${baseRef}..${headRef} --reverse -n ${limit} --format="%H|%h|%s|%an|%ad" --date=short`;
  const logOutput = execSync(logCmd, { cwd: repoPath, encoding: 'utf-8' }).trim();
  
  if (!logOutput) {
    return { error: 'No commits found in range', commits: [] };
  }

  const lines = logOutput.split('\n');
  const commits = [];

  for (let i = 0; i < lines.length; i++) {
    const [fullHash, shortHash, subject, author, date] = lines[i].split('|');

    // Fast file list check
    const filesCmd = `git diff-tree --no-commit-id --name-only -r ${fullHash}`;
    const filesOutput = execSync(filesCmd, { cwd: repoPath, encoding: 'utf-8' }).trim();
    const changedFiles = filesOutput ? filesOutput.split('\n') : [];

    // Fast stat summary
    const statCmd = `git show --stat --oneline ${fullHash}`;
    const statLines = execSync(statCmd, { cwd: repoPath, encoding: 'utf-8' }).trim().split('\n');
    const statSummary = statLines.slice(1).join('\n');

    // Precise Scope Drift Evaluation
    let driftCategory = 'IN_SCOPE';
    let driftReason = 'Direct code modification matching defined PR scope';
    let severity = 'low';

    const isDocsOnly = changedFiles.every(f => f.startsWith('docs/') || f.endsWith('.md') || f.endsWith('.txt'));
    const touchesDocs = changedFiles.some(f => f.startsWith('docs/') || f.endsWith('.md'));
    const touchesCi = changedFiles.some(f => f.startsWith('.github/') || f.includes('ci.yml'));
    const touchesAndroid = changedFiles.some(f => f.toLowerCase().includes('android'));
    const touchesDb = changedFiles.some(f => f.includes('postgres') || f.includes('sqlite') || f.includes('migrations'));

    if (isDocsOnly) {
      driftCategory = 'DOCS_JOURNALING_DRIFT';
      driftReason = 'Agent created audit notes, verification docs, or logs instead of delivering functional code.';
      severity = 'high';
    } else if (touchesCi && !definedScope.toLowerCase().includes('ci') && !definedScope.toLowerCase().includes('pipeline')) {
      driftCategory = 'CI_WORKFLOW_DRIFT';
      driftReason = 'Agent drifted into modifying GitHub Actions CI workflows instead of application code.';
      severity = 'medium';
    } else if (touchesAndroid && !definedScope.toLowerCase().includes('android')) {
      driftCategory = 'CROSS_SUBSYSTEM_DRIFT';
      driftReason = 'Agent jumped across boundary into Android app files while working on backend/database scope.';
      severity = 'high';
    } else if (subject.toLowerCase().includes('recheck') || subject.toLowerCase().includes('record') || subject.toLowerCase().includes('retry')) {
      driftCategory = 'STALLED_EVIDENCE_LOOP';
      driftReason = 'Agent is stuck in repetitive self-verification loop without progressing the goal.';
      severity = 'critical';
    }

    commits.push({
      stepIndex: i + 1,
      commitHash: shortHash,
      fullHash,
      title: subject,
      author,
      date,
      changedFilesCount: changedFiles.length,
      changedFiles: changedFiles.slice(0, 15),
      driftCategory,
      driftReason,
      severity,
      statSummary: statSummary.slice(0, 3000)
    });
  }

  // Summary Metrics
  const inScopeCount = commits.filter(c => c.driftCategory === 'IN_SCOPE').length;
  const docsDriftCount = commits.filter(c => c.driftCategory === 'DOCS_JOURNALING_DRIFT').length;
  const ciDriftCount = commits.filter(c => c.driftCategory === 'CI_WORKFLOW_DRIFT').length;
  const crossSubsystemCount = commits.filter(c => c.driftCategory === 'CROSS_SUBSYSTEM_DRIFT').length;
  const stalledCount = commits.filter(c => c.driftCategory === 'STALLED_EVIDENCE_LOOP').length;

  return {
    repoPath,
    baseRef,
    headRef,
    definedScope,
    totalCommits: commits.length,
    metrics: {
      inScopeCount,
      docsDriftCount,
      ciDriftCount,
      crossSubsystemCount,
      stalledCount,
      driftPercentage: Math.round(((commits.length - inScopeCount) / commits.length) * 100)
    },
    commits
  };
}

export function getCommitDiff(repoPath, commitHash) {
  try {
    const diff = execSync(`git show -p --stat ${commitHash}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024
    });
    return diff.length > 80000 ? diff.slice(0, 80000) + '\n\n... [Diff truncated to 80KB for performance] ...' : diff;
  } catch (err) {
    return `Error fetching diff: ${err.message}`;
  }
}
