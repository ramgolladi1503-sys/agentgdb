import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.join(process.env.HOME || '.', '.agentgdb');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const DB_PATH = path.join(DB_DIR, 'traces.db');
const db = new Database(DB_PATH);

// Ingest a Control Tower JSON-RPC approval event turn into AgentGDB
export function ingestControlTowerEvent(session_id, turn_index, method, params, decision = 'pending', latency_ms = 450) {
  const turnId = `ct_turn_${turn_index}_${Date.now()}`;
  
  // Create or update session
  db.prepare(`
    INSERT INTO sessions (id, name, created_at, model, status)
    VALUES (?, ?, ?, ?, 'active')
    ON CONFLICT(id) DO UPDATE SET status='active'
  `).run(session_id, `Aixion Control Tower: ${session_id}`, Date.now(), 'codex-app-server');

  // Format tool call representation
  const isCommand = method.includes('commandExecution');
  const command = isCommand ? (params.command || params.cmd || (Array.isArray(params.item?.command) ? params.item.command.join(' ') : params.item?.command) || 'unknown_cmd') : 'file_change';
  
  const toolCalls = [{
    id: params.item?.id || `call_${turn_index}`,
    function: {
      name: isCommand ? 'bash_run' : 'edit_file',
      arguments: JSON.stringify({ command, cwd: params.item?.cwd || '.' })
    }
  }];

  const toolResults = decision === 'accept' ? { status: 'allowed', decision: 'accept' } : (decision === 'reject' ? { status: 'denied', decision: 'reject' } : null);

  const stmt = db.prepare(`
    INSERT INTO turns (
      id, session_id, turn_index, parent_turn_id, branch_name,
      request_payload, response_payload, tool_calls, tool_results,
      is_cached, breakpoint_hit, tokens, latency_ms, created_at
    ) VALUES (?, ?, ?, ?, 'main', ?, ?, ?, ?, 0, 1, 1250, ?, ?)
  `);

  stmt.run(
    turnId,
    session_id,
    turn_index,
    turn_index > 1 ? `ct_turn_${turn_index - 1}` : null,
    JSON.stringify({ method, params }),
    JSON.stringify({ decision }),
    JSON.stringify(toolCalls),
    toolResults ? JSON.stringify(toolResults) : null,
    latency_ms,
    Date.now()
  );

  return turnId;
}
