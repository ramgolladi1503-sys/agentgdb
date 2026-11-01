# AgentGDB

AgentGDB is an experimental local proxy and transcript viewer. Its tool-call gate applies only to supported OpenAI-style tool calls returned through this proxy. It does not control an agent that bypasses the proxy, and it is not an operating-system sandbox or production security boundary.

## Implemented scope (limited verification)

- A Fastify server with a local web dashboard and WebSocket event stream.
- An OpenAI-compatible `/v1/chat/completions` forwarding endpoint.
- SQLite session/turn metadata storage. Full request and response payload capture is disabled unless explicitly enabled.
- Dashboard first-run workspace and transcript forms, plus an in-memory synthetic demo.
- An official MCP stdio tool adapter with managed workspace read/write and exact allowlisted command execution.
- Durable approval records; the managed adapter executes writes and commands only after an explicit operator decision.
- Capture-aware, hash-checked single-turn playback for complete recorded traces.
- An in-memory virtual filesystem module, not connected as a sandbox for real agents.

See [Feature status and limitations](docs/FEATURE_STATUS.md) and the [readiness audit](docs/evaluation/USABILITY_AND_READINESS_AUDIT.md). Historical 1,000-developer and panel reports are withdrawn; no verified human evaluation has been conducted.

Production readiness is blocked by the evidence requirements in the [release gate](docs/RELEASE_GATE.md).

## Requirements

- Node.js 22 or newer (required by the current native SQLite dependencies).
- npm.

## Install and run locally

```bash
git clone https://github.com/ramgolladi1503-sys/agentgdb.git
cd agentgdb
npm ci
npm run build:css
npm start
```

The compiled dashboard stylesheet is committed for convenient local use; rebuild it after changing dashboard utility classes with `npm run build:css`. Dashboard styles and fonts are served locally and do not require third-party CDN access.

By default the server binds to `127.0.0.1:9099`. Open <http://127.0.0.1:9099/>. Use **Run local demo** for a synthetic event held in memory, register a workspace with a narrow relative path allowlist, and optionally observe a JSONL transcript by entering its explicit absolute path. The demo makes no upstream call and writes no trace. Parsing reports unsupported formats and malformed JSONL lines.

Start the dashboard with `npm start`. Configure a coding agent's MCP client to launch `node /absolute/path/to/agentgdb/bin/agentgdb-mcp.js`. The dashboard must remain running so it can serve as the approval operator. This adapter exposes `agentgdb_read_file`, `agentgdb_write_file`, and `agentgdb_run_command`. Disable the coding agent's native filesystem and terminal tools for actions that must pass through AgentGDB; otherwise the agent can bypass the adapter. Select the workspace in the dashboard before using the tools.

For Claude Code, register the local stdio server with `claude mcp add --scope user agentgdb -- node /absolute/path/to/agentgdb/bin/agentgdb-mcp.js`, then check `claude mcp get agentgdb` for a connected status. Start the agent with `claude --tools ""` for a session where built-in tools are disabled; MCP tools remain available. Do not rely on the gate if the client exposes another filesystem or terminal route. AgentGDB has verified local Claude Code MCP discovery; a model-driven edit has not been release-tested.

`allowedCommands` entries are exact JSON serialized argument arrays. For example, the value `"[\"npm\",\"test\"]"` authorizes only `npm` with one `test` argument. In the setup form, enter a JSON array containing that string: `["[\"npm\",\"test\"]"]`. The command is launched without a shell, in the workspace directory, with a reduced environment, a timeout, and output cap. Every run still requires approval.

For the separate OpenAI-compatible proxy workflow, set the client's base URL to `http://127.0.0.1:9099/v1`. That proxy withholds supported tool calls before returning them to the client; actual execution is only managed when the client invokes the AgentGDB MCP tools. Proxy mediation cannot prevent an agent using another tool provider or endpoint.

The gate checks parsed tool names and arguments before the proxy returns tool calls to the client. Supported file-like calls need a recognized relative path argument; unknown tool schemas and malformed paths are denied. Workspace paths are checked against the selected root and existing symlinks are rejected if they escape it. This is a filesystem snapshot check, not protection against races or a client with a different workspace. Shell calls are denied unless the entire command exactly matches a project `allowedCommands` entry, and matching commands still require human approval. Streamed completions are buffered until policy and approval decisions finish, so expect added latency. This is a proxy-level gate only: AgentGDB does not execute the tool and cannot stop a client from using another endpoint or bypassing the proxy. The operator token helps prevent accidental self-approval over the local API; it cannot defend against a hostile process with the same OS-user access. Do not use this as the sole safeguard for sensitive or mission-critical workloads.

When AgentGDB first loads an existing project registry, it checks for exact legacy seeded personal paths from earlier versions. Matching seeded entries are removed; customized and unrelated entries are preserved. Before rewriting, AgentGDB creates `~/.agentgdb/projects.json.pre-default-cleanup` as a restricted-permission backup. Review the backup before deleting it.

To make the OpenAI-compatible proxy retain request and response payloads, explicitly set `AGENTGDB_TRACE_CAPTURE=true` before startup. Common credential patterns are redacted before local persistence, and credential-like tool-call arguments are denied; pattern redaction is not comprehensive, so payloads can still contain sensitive data. Keep capture disabled unless needed and delete the database when appropriate. Session metadata and token/latency counts are stored regardless.

To automatically delete old sessions and turns on startup, set `AGENTGDB_TRACE_RETENTION_DAYS` to a whole number from 1 through 3650. Retention is disabled when unset. This is a destructive cleanup setting; choose the period deliberately and keep separate backups if you need longer history.

### Configuration keys

| Key | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Listen address. Non-loopback requires `AGENTGDB_AUTH_TOKEN`. |
| `PORT` | `9099` | HTTP/WebSocket port. |
| `AGENTGDB_AUTH_TOKEN` | unset | Required bearer token for non-loopback binding. |
| `AGENTGDB_TRACE_CAPTURE` | `false` | Set to `true` to store full proxy request/response payloads. |
| `AGENTGDB_TRACE_RETENTION_DAYS` | unset | Optional startup cleanup window in whole days (`1`–`3650`). |
| `AGENTGDB_APPROVAL_TIMEOUT_MS` | `300000` | Approval wait (`1000`–`3600000` ms). Expiry denies the tool call. |
| `AGENTGDB_APPROVAL_TOKEN` | generated per run | Optional operator token, minimum 32 bytes. If unset, a random token is printed once at startup; enter it in the dashboard to decide approvals. It changes after restart. |
| `UPSTREAM_BASE_URL` | `https://api.openai.com` | OpenAI-compatible upstream base URL. |
| `AGENTGDB_UPSTREAM_TIMEOUT_MS` | `120000` | Upstream request timeout (`1000`–`600000` ms); timeout fails the proxy call closed. |
| `AGENTGDB_COMMAND_TIMEOUT_MS` | `120000` | Managed command timeout (`1000`–`600000` ms). |

### Migration and rollout

The SQLite schema adds nullable replay hashes/version columns and durable approval execution fields automatically; existing trace rows are preserved, but older rows are not replayable unless full request and response payloads were captured. Existing project entries without an explicit `workspacePath` remain available for viewing but cannot authorize managed tool calls. No existing workspace is guessed. Start locally, run the synthetic demo, register a disposable workspace with a narrow allowlist such as `src/**`, verify deny and approval behavior with a supported MCP client, then run the cross-platform CI matrix and obtain independent security review before using valuable workspaces. Keep the first rollout local and non-critical.

To remove stored turns and approval records older than a Unix timestamp in milliseconds, call `DELETE /api/traces?before=<timestamp>` while the local daemon is running. Add `&includeSessionMetadata=true` to also delete old session summaries that have no surviving turns; summaries for sessions with newer turns remain. The purge is transactional and checkpoints the WAL, but this is not a guarantee against filesystem snapshots or backups.

To bind beyond loopback, set both `HOST` and `AGENTGDB_AUTH_TOKEN`. Non-loopback startup without a token fails. Send `Authorization: Bearer <token>` to API and WebSocket handshake requests. Static dashboard resources are also behind the token, so use a client that can set the authorization header or a trusted local reverse proxy. This is a basic shared-token gate; do not expose this early software directly to the public internet.

## Tests

```bash
npm test
```

Tests are local and use temporary directories/configuration. They include managed MCP execution, approval restart/timeout, HTTP/static/WebSocket auth, trace deletion, hostile transcript display source checks, and narrow scope/redaction probes. GitHub Actions defines Node 22 on Linux, macOS, and Windows; remote matrix results must be green before claiming those platforms verified. Tests do not certify production readiness or enforcement against arbitrary agent processes. The adversarial test file consists of narrow unit probes, not a red-team exercise.

## Safety and data limits

- Transcript watching detects events after they are written; it does not prevent filesystem or shell operations.
- `/api/policy/check` reports path policy; proxy tool-call enforcement is separate and applies only to supported calls through `/v1/chat/completions`.
- Approval proposals retain exact action arguments in the local SQLite database so the operator can review what is being approved. Database and project configuration have restricted Unix permissions; Windows ACL behavior needs platform validation.
- A separate operator token is required for approval decisions. Keep startup output private. The same-OS-user threat boundary is not protected by this token.
- The virtual filesystem is a library module and is not connected to agent execution.
- Full payload retention is opt-in; trace metadata remains local in SQLite.
- Avoid pointing the tool at sensitive workspaces until an independent security review and real-agent compatibility validation are complete.

## License

No license file is currently present. Do not assume the README's former MIT badge constituted a license grant. A license must be added by the repository owner before reuse terms are clear.
