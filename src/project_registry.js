import fs from 'fs';
import path from 'path';

/** Stores only projects explicitly registered by the operator. */

const CONFIG_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.agentgdb', 'projects.json');
const RESTRICTIVE_MODES = process.platform !== 'win32';

function secureConfigDirectory() {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  if (RESTRICTIVE_MODES) fs.chmodSync(path.dirname(CONFIG_PATH), 0o700);
}

function writeConfig(config) {
  secureConfigDirectory();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  if (RESTRICTIVE_MODES) fs.chmodSync(CONFIG_PATH, 0o600);
}
const LEGACY_DEFAULTS = [
  { id: 'antigravity-live', sessionPath: '/.gemini/antigravity/brain/554eb738-91a4-4f63-9ce5-90279b2400b3/.system_generated/logs/transcript.jsonl' },
  { id: 'aixion-control-tower', workspacePath: '/Users/madhuram/aixion-control-tower' },
  { id: 'aixion-control-tower', sessionPath: '/.codex/sessions/2026/11/01/rollout-2026-11-01T11-11-20-01a195a0-6b5a-71c3-843a-bd3ad57ec0fa.jsonl' },
  { id: 'tradebot-live', workspacePath: '/Users/madhuram/tradebot' },
  { id: 'tradebot-live', sessionPath: '/.codex/sessions/2026/11/01/rollout-2026-11-01T16-17-41-01a196b8-e241-7d73-ad13-ff6d03fdee62.jsonl' }
];

function removeSeededDefaults(config) {
  if (!Array.isArray(config.projects)) throw new Error('AgentGDB project configuration must contain a projects array');
  const isSeededDefault = (project) => LEGACY_DEFAULTS.some((seed) =>
    project?.id === seed.id && Object.entries(seed).some(([key, value]) => key !== 'id' && typeof project[key] === 'string' && project[key].endsWith(value))
  );
  const removed = config.projects.filter(isSeededDefault);
  if (removed.length === 0) return config;

  const dir = path.dirname(CONFIG_PATH);
  if (RESTRICTIVE_MODES) fs.chmodSync(dir, 0o700);
  const backupPath = `${CONFIG_PATH}.pre-default-cleanup`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(CONFIG_PATH, backupPath, fs.constants.COPYFILE_EXCL);
    if (RESTRICTIVE_MODES) fs.chmodSync(backupPath, 0o600);
  }
  config.projects = config.projects.filter((project) => !isSeededDefault(project));
  if (removed.some((project) => project.id === config.activeProjectId)) config.activeProjectId = null;
  writeConfig(config);
  return config;
}

export function loadProjects() {
  if (!fs.existsSync(CONFIG_PATH)) {
    // Start empty. Never point a new install at a guessed or personal transcript.
    const initialConfig = {
      activeProjectId: null,
      projects: []
    };
    writeConfig(initialConfig);
    return initialConfig;
  }

  try {
    return removeSeededDefaults(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')));
  } catch (e) {
    throw new Error(`Invalid AgentGDB project configuration at ${CONFIG_PATH}: ${e.message}`);
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
  writeConfig(config);
  return config;
}

export function setActiveProject(projectId) {
  const config = loadProjects();
  if (!config.projects.some((project) => project.id === projectId)) {
    throw new Error(`Unknown project id: ${projectId}`);
  }
  config.activeProjectId = projectId;
  writeConfig(config);
  return config;
}
