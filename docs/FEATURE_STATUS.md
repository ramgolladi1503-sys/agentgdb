# Feature status and limitations

Status reflects a source-level review as of 2026-11-02, not independent certification.

| Capability previously advertised | Current status | Limitation |
|---|---|---|
| Local web dashboard and WebSocket | Implemented, minimally | Browser workflow needs broader validation. |
| OpenAI-compatible chat completion proxy | Implemented, minimally | No demonstrated Anthropic/Ollama compatibility or production reliability. |
| Transcript monitoring | Best effort | Observes files after writes; does not control agent execution. |
| Active goal extraction | Partial | Depends on specific transcript schemas and may not find goals. |
| Scope drift alerts | Advisory | Transcript drift alerts remain observational. |
| Proxy tool-call gate | Implemented, narrowly | Runs before supported OpenAI-style tool calls are returned, including buffered streams. Unknown schemas/paths and workspace symlink escapes deny. Snapshot checks are race-prone; not OS enforcement; a client can bypass the proxy. |
| Managed MCP tool adapter | Implemented, narrowly | Official stdio server exposes read, write, and exact argv command tools. Writes and commands execute in AgentGDB after durable approval. Claude Code CLI MCP discovery has been verified locally; a model-driven task has not. Agents must disable alternate native tools to keep actions on this path. |
| MCP scope check helper | Advisory | Requires an active watcher; reports `UNKNOWN`/denies when unavailable. It is diagnostic, not the managed tool adapter. |
| Trace payload capture | Opt-in, redacted heuristically | `AGENTGDB_TRACE_CAPTURE=true`; common credential patterns are redacted, but unknown secret formats can remain. Metadata is stored regardless. Age-based purge removes turns and approval records. |
| Trace retention | Optional | `AGENTGDB_TRACE_RETENTION_DAYS=1..3650` purges expired turns and sessions at startup; unset disables automatic cleanup. |
| Trace deletion | Implemented, local | `DELETE /api/traces?before=<ms>` transactionally removes older turns and approvals; `includeSessionMetadata=true` also removes old session summaries with no remaining turns. SQLite secure-delete and WAL checkpointing are used, but filesystem snapshots/backups are outside the deletion boundary. |
| Human approval | Implemented, narrowly | Durable SQLite queue; managed writes/commands and proxy calls wait for explicit token-authenticated decisions. Timeout, cancellation, unavailable dashboard, and daemon restart deny. Managed execution status is recorded. Same-user hostile process is outside the token's security boundary. |
| Execution freeze / subprocess halt | Not implemented | No general process controller is wired into the proxy. |
| Single-turn captured replay | Implemented, narrowly | Requires full payload capture and matching SHA-256 hashes. Incomplete payloads fail explicitly; fixture coverage verifies playback after daemon restart and reports zero upstream calls. This returns stored inputs/outputs; it does not re-run an agent or prove multi-turn determinism. |
| 240-hour replay | Not implemented/verified | No long-duration or multi-turn deterministic execution replay evidence. |
| Zero-cost fork/resume | Not verified | Cached turns do not establish zero cost or complete forked execution. |
| Secret filtering | Partial | Common credential patterns are denied in managed actions and redacted in persisted traces; this is heuristic and does not cover all secrets or all prompt paths. |
| Virtual filesystem | Isolated module | Not wired into agent I/O; path containment is checked, but it is not a sandbox. |
| Cryptographic attestation / PR evidence | Not suitable for trust claims | Current helper does not establish trusted identity or prove that changes were in scope. |
| 1,000-developer evaluation | Withdrawn | Former report was generated from synthetic random scores and fabricated feedback. |
| Production release gate | Defined locally; BLOCKED | `docs/RELEASE_GATE.md` lists required evidence. Repository branch protection is not configured or verified; cross-platform CI, real-agent action run, independent security review, and user pilot remain outstanding. |

Do not upgrade these statuses based on unit tests alone. Any move to broader “enforced” or “production-ready” requires end-to-end tests through actual supported agent clients, adversarial path/argument coverage, cross-platform CI results, and an independent security review.
