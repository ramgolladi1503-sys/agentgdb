# AgentGDB

AgentGDB is an early local tool for recording OpenAI-compatible chat-completion traffic and viewing agent transcript events. It is **experimental software**. It is not a production-ready debugger, security boundary, approval system, or execution controller.

## Implemented scope (limited verification)

- A Fastify server with a local web dashboard and WebSocket event stream.
- An OpenAI-compatible `/v1/chat/completions` forwarding endpoint.
- SQLite session/turn metadata storage. Full request and response payload capture is disabled unless explicitly enabled.
- API-based transcript/project registration and best-effort transcript observation; there is no setup form in the dashboard yet.
- An in-memory virtual filesystem module, not connected as a sandbox for real agents.

See [Feature status and limitations](docs/FEATURE_STATUS.md) and the [readiness audit](docs/evaluation/USABILITY_AND_READINESS_AUDIT.md). Historical 1,000-developer and panel reports are withdrawn; no verified human evaluation has been conducted.

## Requirements

- Node.js 20.11 or newer (native SQLite dependency compatibility varies by platform).
- npm.

## Install and run locally

```bash
git clone https://github.com/ramgolladi1503-sys/agentgdb.git
cd agentgdb
npm ci
npm start
```

By default the server binds to `127.0.0.1:9099`. Open <http://127.0.0.1:9099/>. No project or transcript is selected at first launch. Project registration currently requires `POST /api/projects`, and transcript observation requires `POST /api/live/watch` with an explicit absolute path; the dashboard does not yet provide a setup form. AgentGDB does not guess private session locations.

When AgentGDB first loads an existing project registry, it checks for exact legacy seeded personal paths from earlier versions. Matching seeded entries are removed; customized and unrelated entries are preserved. Before rewriting, AgentGDB creates `~/.agentgdb/projects.json.pre-default-cleanup` as a restricted-permission backup. Review the backup before deleting it.

To make the OpenAI-compatible proxy retain request and response payloads, explicitly set `AGENTGDB_TRACE_CAPTURE=true` before startup. Payload capture may store sensitive prompts and tool arguments in `~/.agentgdb/traces.db`; keep it disabled unless needed and delete the database when appropriate. Session metadata and token/latency counts are stored regardless.

To automatically delete old sessions and turns on startup, set `AGENTGDB_TRACE_RETENTION_DAYS` to a whole number from 1 through 3650. Retention is disabled when unset. This is a destructive cleanup setting; choose the period deliberately and keep separate backups if you need longer history.

### Configuration keys

| Key | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Listen address. Non-loopback requires `AGENTGDB_AUTH_TOKEN`. |
| `PORT` | `9099` | HTTP/WebSocket port. |
| `AGENTGDB_AUTH_TOKEN` | unset | Required bearer token for non-loopback binding. |
| `AGENTGDB_TRACE_CAPTURE` | `false` | Set to `true` to store full proxy request/response payloads. |
| `AGENTGDB_TRACE_RETENTION_DAYS` | unset | Optional startup cleanup window in whole days (`1`–`3650`). |
| `UPSTREAM_BASE_URL` | `https://api.openai.com` | OpenAI-compatible upstream base URL. |

To remove stored turn payloads and metadata older than a Unix timestamp in milliseconds, call `DELETE /api/traces?before=<timestamp>` while the local daemon is running. This deletes matching turns; session summary rows are retained. The DB uses SQLite secure-delete and checkpoints the WAL after purging, but this is not a guarantee against filesystem snapshots or backups.

To bind beyond loopback, set both `HOST` and `AGENTGDB_AUTH_TOKEN`. Non-loopback startup without a token fails. Send `Authorization: Bearer <token>` to API and WebSocket handshake requests. Static dashboard resources are also behind the token, so use a client that can set the authorization header or a trusted local reverse proxy. This is a basic shared-token gate; do not expose this early software directly to the public internet.

## Tests

```bash
npm test
```

Tests are local and use temporary directories/configuration. They do not certify production readiness or active enforcement against arbitrary agent processes. The older adversarial test file consists of narrow unit probes, not a red-team exercise.

## Safety and data limits

- Transcript watching detects events after they are written; it does not prevent filesystem or shell operations.
- The scope-check endpoint is advisory and reports that limitation. It is not a security gate.
- Human approval workflow is not implemented; the MCP approval request fails explicitly.
- The virtual filesystem is a library module and is not connected to agent execution.
- Full payload retention is opt-in; trace metadata remains local in SQLite.
- Avoid pointing the tool at sensitive workspaces until the security and retention controls have been reviewed for your use case.

## License

No license file is currently present. Do not assume the README's former MIT badge constituted a license grant. A license must be added by the repository owner before reuse terms are clear.
