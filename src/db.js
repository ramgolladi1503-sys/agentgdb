import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || '.';
const DB_DIR = path.join(HOME_DIR, '.agentgdb');
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
    schema_version INTEGER DEFAULT 1,
    engine_version TEXT DEFAULT '1.0.0',
    request_hash TEXT,
    response_hash TEXT,
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

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    action_json TEXT NOT NULL,
    risk TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','DENIED','EXPIRED','REJECTED_RESTART')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT,
    decision_reason TEXT,
    execution_status TEXT NOT NULL DEFAULT 'NOT_STARTED',
    execution_result TEXT
  );
  CREATE INDEX IF NOT EXISTS approvals_status_created ON approvals(status, created_at);
`);

for (const [column, definition] of [
  ['schema_version', 'INTEGER DEFAULT 1'], ['engine_version', "TEXT DEFAULT '1.0.0'"],
  ['request_hash', 'TEXT'], ['response_hash', 'TEXT']
]) {
  const columns = db.prepare('PRAGMA table_info(turns)').all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE turns ADD COLUMN ${column} ${definition}`);
}
const approvalColumns = db.prepare('PRAGMA table_info(approvals)').all().map((row) => row.name);
if (!approvalColumns.includes('execution_status')) db.exec("ALTER TABLE approvals ADD COLUMN execution_status TEXT NOT NULL DEFAULT 'NOT_STARTED'");
if (!approvalColumns.includes('execution_result')) db.exec('ALTER TABLE approvals ADD COLUMN execution_result TEXT');

export function rejectPendingApprovals(status = 'REJECTED_RESTART', reason = 'Interrupted request cannot be resumed') {
  if (!['REJECTED_RESTART', 'DENIED'].includes(status)) throw new TypeError('Invalid fail-closed approval status');
  return db.prepare('UPDATE approvals SET status=?, decided_at=?, decision_reason=? WHERE status=\'PENDING\'').run(status, Date.now(), reason).changes;
}

export function expireStaleApprovals(now = Date.now()) {
  return db.prepare("UPDATE approvals SET status='EXPIRED', decided_at=? WHERE status='PENDING' AND expires_at<=?").run(now, now).changes;
}

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
  turn.schema_version ??= 1;
  turn.engine_version ??= '1.0.0';
  turn.request_hash ??= turn.request_payload ? createHash('sha256').update(turn.request_payload).digest('hex') : null;
  turn.response_hash ??= turn.response_payload ? createHash('sha256').update(turn.response_payload).digest('hex') : null;
  const stmt = db.prepare(`
    INSERT INTO turns (
      id, session_id, turn_index, parent_turn_id, branch_name,
      request_payload, response_payload, tool_calls, tool_results,
      is_cached, breakpoint_hit, schema_version, engine_version, request_hash, response_hash, tokens, latency_ms, created_at
    ) VALUES (
      @id, @session_id, @turn_index, @parent_turn_id, @branch_name,
      @request_payload, @response_payload, @tool_calls, @tool_results,
      @is_cached, @breakpoint_hit, @schema_version, @engine_version, @request_hash, @response_hash, @tokens, @latency_ms, @created_at
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

export function purgeApprovalsBefore(timestamp) {
  if (!Number.isFinite(timestamp)) throw new TypeError('timestamp must be a finite number');
  const result = db.prepare('DELETE FROM approvals WHERE created_at < ?').run(timestamp);
  db.pragma('wal_checkpoint(TRUNCATE)');
  return result.changes;
}

/** Delete stored trace rows atomically; optionally remove summaries with no surviving turns. */
export function purgeTraceDataBefore(timestamp, { includeSessionMetadata = false } = {}) {
  if (!Number.isFinite(timestamp)) throw new TypeError('timestamp must be a finite number');
  if (typeof includeSessionMetadata !== 'boolean') throw new TypeError('includeSessionMetadata must be boolean');
  const result = db.transaction(() => {
    const deletedTurns = db.prepare('DELETE FROM turns WHERE created_at < ?').run(timestamp).changes;
    const deletedApprovals = db.prepare('DELETE FROM approvals WHERE created_at < ?').run(timestamp).changes;
    const deletedSessions = includeSessionMetadata
      ? db.prepare(`DELETE FROM sessions WHERE created_at < ?
          AND NOT EXISTS (SELECT 1 FROM turns WHERE turns.session_id = sessions.id)`).run(timestamp).changes
      : 0;
    return { deletedTurns, deletedApprovals, deletedSessions };
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  return result;
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
    db.prepare('DELETE FROM approvals WHERE created_at < ?').run(cutoff);
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

export function getReplayTurn(sessionId, turnIndex, branch = 'main') {
  return db.prepare(`SELECT id, session_id, turn_index, branch_name, request_payload, response_payload,
      request_hash, response_hash, schema_version, engine_version
    FROM turns WHERE session_id=? AND turn_index=? AND branch_name=? ORDER BY created_at DESC LIMIT 1`)
    .get(sessionId, turnIndex, branch);
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

export function createApproval({ id, sessionId, action, risk, expiresAt }) {
  db.prepare(`INSERT INTO approvals
    (id, session_id, action_json, risk, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`)
    .run(id, sessionId, JSON.stringify(action), risk, Date.now(), expiresAt);
  return getApproval(id);
}

export function getApproval(id) {
  const row = db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
  return row ? { ...row, action: JSON.parse(row.action_json) } : null;
}

export function getPendingApprovals() {
  expireStaleApprovals();
  return db.prepare("SELECT * FROM approvals WHERE status='PENDING' ORDER BY created_at").all()
    .map((row) => ({ id: row.id, session_id: row.session_id, action: JSON.parse(row.action_json), risk: row.risk, status: row.status, created_at: row.created_at, expires_at: row.expires_at }));
}

export function getRecentApprovals(limit = 50) {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
  return db.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?').all(safeLimit)
    .map((row) => ({ id: row.id, session_id: row.session_id, action: JSON.parse(row.action_json), risk: row.risk, status: row.status, created_at: row.created_at, expires_at: row.expires_at, decided_at: row.decided_at, decided_by: row.decided_by, decision_reason: row.decision_reason, execution_status: row.execution_status, execution_result: row.execution_result ? JSON.parse(row.execution_result) : null }));
}

export function decideApproval(id, decision, decidedBy = 'local-operator', reason = null) {
  if (!['APPROVED', 'DENIED'].includes(decision)) throw new TypeError('Invalid approval decision');
  const result = db.prepare(`UPDATE approvals SET status=?, decided_at=?, decided_by=?, decision_reason=?
    WHERE id=? AND status='PENDING' AND expires_at>?`).run(decision, Date.now(), decidedBy, reason, id, Date.now());
  return result.changes === 1 ? getApproval(id) : null;
}

export function expireApproval(id) {
  db.prepare("UPDATE approvals SET status='EXPIRED', decided_at=? WHERE id=? AND status='PENDING'").run(Date.now(), id);
  return getApproval(id);
}

export function recordApprovalExecution(id, status, result = null) {
  if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) throw new TypeError('Invalid managed action result');
  const summary = result === null ? null : JSON.stringify(result);
  return db.prepare("UPDATE approvals SET execution_status=?, execution_result=? WHERE id=? AND status='APPROVED' AND execution_status='NOT_STARTED'")
    .run(status, summary, id).changes === 1;
}

export default db;
