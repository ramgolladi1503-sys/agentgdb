import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.join(process.env.HOME || '.', '.agentgdb');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const DB_PATH = path.join(DB_DIR, 'traces.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('secure_delete = ON');
if (process.platform !== 'win32') {
  fs.chmodSync(DB_DIR, 0o700);
  fs.chmodSync(DB_PATH, 0o600);
}

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT,
    created_at INTEGER,
    model TEXT,
    total_tokens INTEGER DEFAULT 0,
    cost REAL DEFAULT 0.0,
    status TEXT DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    turn_index INTEGER,
    parent_turn_id TEXT,
    branch_name TEXT DEFAULT 'main',
    request_payload TEXT,
    response_payload TEXT,
    tool_calls TEXT,
    tool_results TEXT,
    is_cached INTEGER DEFAULT 0,
    breakpoint_hit INTEGER DEFAULT 0,
    tokens INTEGER DEFAULT 0,
    latency_ms INTEGER DEFAULT 0,
    created_at INTEGER,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS breakpoints (
    id TEXT PRIMARY KEY,
    rule_type TEXT, -- 'tool_name', 'error_status', 'token_limit', 'regex'
    pattern TEXT,
    enabled INTEGER DEFAULT 1
  );
`);

export function createSession(id, name, model) {
  const stmt = db.prepare(`
    INSERT INTO sessions (id, name, created_at, model, status)
    VALUES (?, ?, ?, ?, 'active')
    ON CONFLICT(id) DO UPDATE SET model=excluded.model
  `);
  stmt.run(id, name || id, Date.now(), model || 'unknown');
}

export function getSession(id) {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
}

export function getAllSessions() {
  return db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT 50`).all();
}

export function recordTurn(turn) {
  const stmt = db.prepare(`
    INSERT INTO turns (
      id, session_id, turn_index, parent_turn_id, branch_name,
      request_payload, response_payload, tool_calls, tool_results,
      is_cached, breakpoint_hit, tokens, latency_ms, created_at
    ) VALUES (
      @id, @session_id, @turn_index, @parent_turn_id, @branch_name,
      @request_payload, @response_payload, @tool_calls, @tool_results,
      @is_cached, @breakpoint_hit, @tokens, @latency_ms, @created_at
    )
  `);
  stmt.run(turn);

  // Update session token counts
  if (turn.tokens) {
    db.prepare(`UPDATE sessions SET total_tokens = total_tokens + ? WHERE id = ?`)
      .run(turn.tokens, turn.session_id);
  }
}

export function purgeTurnsBefore(timestamp) {
  if (!Number.isFinite(timestamp)) throw new TypeError('timestamp must be a finite number');
  const result = db.prepare('DELETE FROM turns WHERE created_at < ?').run(timestamp);
  db.pragma('wal_checkpoint(TRUNCATE)');
  return result.changes;
}

export function applyTraceRetention(now = Date.now()) {
  const rawDays = process.env.AGENTGDB_TRACE_RETENTION_DAYS;
  if (rawDays === undefined || rawDays === '') return 0;
  const days = Number(rawDays);
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    throw new Error('AGENTGDB_TRACE_RETENTION_DAYS must be an integer from 1 to 3650');
  }
  if (!Number.isInteger(days)) throw new Error('AGENTGDB_TRACE_RETENTION_DAYS must be a whole number of days');
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const result = db.transaction(() => {
    const deletedTurns = db.prepare('DELETE FROM turns WHERE created_at < ?').run(cutoff).changes;
    const deletedSessions = db.prepare(`
      DELETE FROM sessions
      WHERE created_at < ?
        AND NOT EXISTS (SELECT 1 FROM turns WHERE turns.session_id = sessions.id)
    `).run(cutoff).changes;
    return deletedTurns + deletedSessions;
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  return result;
}

export function getTurnsForSession(sessionId, branch = 'main') {
  return db.prepare(`
    SELECT * FROM turns 
    WHERE session_id = ? AND branch_name = ? 
    ORDER BY turn_index ASC
  `).all(sessionId, branch);
}

export function getTurnById(turnId) {
  return db.prepare(`SELECT * FROM turns WHERE id = ?`).get(turnId);
}

export function updateTurnMock(turnId, toolResults) {
  db.prepare(`
    UPDATE turns 
    SET tool_results = ?, is_cached = 1 
    WHERE id = ?
  `).run(JSON.stringify(toolResults), turnId);
}

export function getBreakpoints() {
  return db.prepare(`SELECT * FROM breakpoints WHERE enabled = 1`).all();
}

export function addBreakpoint(id, ruleType, pattern) {
  db.prepare(`
    INSERT OR REPLACE INTO breakpoints (id, rule_type, pattern, enabled)
    VALUES (?, ?, ?, 1)
  `).run(id, ruleType, pattern);
}

export function removeBreakpoint(id) {
  db.prepare(`DELETE FROM breakpoints WHERE id = ?`).run(id);
}

export default db;
