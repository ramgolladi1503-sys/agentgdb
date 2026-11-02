import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

/** Stores only projects explicitly registered by the operator. */

const CONFIG_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.agentgdb', 'projects.json');
const RESTRICTIVE_MODES = process.platform !== 'win32';

function secureConfigDirectory() {
  const directoryPath = path.dirname(CONFIG_PATH);
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(directoryPath);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('AgentGDB project registry directory must be a real directory; refusing symlinked or non-directory state paths.');
  }
  if (RESTRICTIVE_MODES) fs.chmodSync(directoryPath, 0o700);
}

function assertSafeConfigFile() {
  try {
    const configFile = fs.lstatSync(CONFIG_PATH);
    if (!configFile.isFile() || configFile.isSymbolicLink() || configFile.nlink > 1) {
      throw new Error('AgentGDB project registry must be a regular, singly linked file; refusing symlinked or aliased config paths.');
    }
    if (RESTRICTIVE_MODES) fs.chmodSync(CONFIG_PATH, 0o600);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function writeConfig(config) {
  secureConfigDirectory();
  assertSafeConfigFile();
  const temporaryPath = path.join(path.dirname(CONFIG_PATH), `.projects-${randomUUID()}.tmp`);
  let file;
  try {
    file = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
    fs.fsyncSync(file);
    fs.closeSync(file);
    file = undefined;
    if (RESTRICTIVE_MODES) fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, CONFIG_PATH);
    if (RESTRICTIVE_MODES) fs.chmodSync(CONFIG_PATH, 0o600);
    // Persist the directory entry where supported so a crash after rename
    // does not silently lose the registry update.
    try {
      const directory = fs.openSync(path.dirname(CONFIG_PATH), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error.code)) throw error;
    }
  } catch (error) {
    if (file !== undefined) {
      try { fs.closeSync(file); } catch {}
    }
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}
// Match legacy seeded paths by their product-owned suffix only. Avoid embedding
// developer-specific absolute home paths or transcript identifiers in source.
const LEGACY_DEFAULTS = [
  { id: 'antigravity-live', name: 'Current Antigravity Session', key: 'sessionPath', suffix: '/.gemini/antigravity/brain/', ending: '/.system_generated/logs/transcript.jsonl' },
  { id: 'aixion-control-tower', name: 'Aixion Control Tower', key: 'workspacePath', suffix: '/aixion-control-tower' },
  { id: 'aixion-control-tower', name: 'Current Aixion Session', key: 'sessionPath', suffix: '/.codex/sessions/', ending: '.jsonl' },
  { id: 'tradebot-live', name: 'TradeBot Engine', key: 'workspacePath', suffix: '/tradebot' },
  { id: 'tradebot-live', name: 'Current TradeBot Session', key: 'sessionPath', suffix: '/.codex/sessions/', ending: '.jsonl' }
];

function removeSeededDefaults(config) {
  if (!Array.isArray(config.projects)) throw new Error('AgentGDB project configuration must contain a projects array');
  const isSeededDefault = (project) => LEGACY_DEFAULTS.some((seed) => {
    const value = project?.[seed.key];
    return project?.id === seed.id && project?.name === seed.name && typeof value === 'string' &&
      value.includes(seed.suffix) && (!seed.ending || value.endsWith(seed.ending));
  });
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
  secureConfigDirectory();
  if (!assertSafeConfigFile()) {
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
