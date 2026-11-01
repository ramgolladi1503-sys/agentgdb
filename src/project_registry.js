import fs from 'fs';
import path from 'path';

/**
 * ProjectRegistry
 * Automatically auto-discovers or lets developers register active project workspaces.
 * Monitors:
 * 1. Project path (e.g., /Users/madhuram/tradebot, /Users/madhuram/aixion-control-tower)
 * 2. Active agent session log location (Codex session or Antigravity conversation brain)
 * 3. Declared Boundary & Allowed/Forbidden paths
 */

const CONFIG_PATH = path.join(process.env.HOME || '.', '.agentgdb', 'projects.json');

export function loadProjects() {
  if (!fs.existsSync(CONFIG_PATH)) {
    // Default initial starter template
    const initialConfig = {
      activeProjectId: 'antigravity-live',
      projects: [
        {
          id: 'antigravity-live',
          name: 'Current Antigravity Session',
          agentType: 'antigravity',
          workspacePath: process.cwd(),
          sessionPath: `${process.env.HOME}/.gemini/antigravity/brain/554eb738-91a4-4f63-9ce5-90279b2400b3/.system_generated/logs/transcript.jsonl`,
          allowedPaths: ['src/**', 'public/**'],
          forbiddenPaths: ['tradebot/**', 'docs/verification/**', '.github/workflows/**']
        },
        {
          id: 'aixion-control-tower',
          name: 'Aixion Control Tower',
          agentType: 'codex',
          workspacePath: '/Users/madhuram/aixion-control-tower',
          sessionPath: `${process.env.HOME}/.codex/sessions/2026/11/01/rollout-2026-11-01T11-11-20-01a195a0-6b5a-71c3-843a-bd3ad57ec0fa.jsonl`,
          allowedPaths: ['backend/app/postgres*', 'backend/tests/test_postgres*'],
          forbiddenPaths: ['docs/**', 'mobile/android/**', '.github/workflows/**']
        },
        {
          id: 'tradebot-live',
          name: 'TradeBot Engine',
          agentType: 'codex',
          workspacePath: '/Users/madhuram/tradebot',
          sessionPath: `${process.env.HOME}/.codex/sessions/2026/11/01/rollout-2026-11-01T16-17-41-01a196b8-e241-7d73-ad13-ff6d03fdee62.jsonl`,
          allowedPaths: ['core/analytics/**', 'tests/**'],
          forbiddenPaths: ['run_live.sh', 'credentials.py', '.env', 'docs/**']
        }
      ]
    };
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(initialConfig, null, 2));
    return initialConfig;
  }

  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    return { activeProjectId: null, projects: [] };
  }
}

export function saveProject(project) {
  const config = loadProjects();
  const existingIdx = config.projects.findIndex(p => p.id === project.id);
  if (existingIdx >= 0) {
    config.projects[existingIdx] = { ...config.projects[existingIdx], ...project };
  } else {
    config.projects.push(project);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return config;
}

export function setActiveProject(projectId) {
  const config = loadProjects();
  config.activeProjectId = projectId;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return config;
}
