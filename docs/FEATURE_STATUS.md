# Feature status and limitations

Status reflects a source-level review as of 2026-11-02, not independent certification.

| Capability previously advertised | Current status | Limitation |
|---|---|---|
| Local web dashboard and WebSocket | Implemented, minimally | Browser workflow needs broader validation. |
| OpenAI-compatible chat completion proxy | Implemented, minimally | No demonstrated Anthropic/Ollama compatibility or production reliability. |
| Transcript monitoring | Best effort | Observes files after writes; does not control agent execution. |
| Active goal extraction | Partial | Depends on specific transcript schemas and may not find goals. |
| Scope drift alerts | Advisory | No enforcement; scope parsing is lexical and must not be treated as a security control. |
| MCP scope check | Advisory | Requires an active watcher; reports `UNKNOWN`/denies when unavailable. Does not mediate tools. |
| Trace payload capture | Opt-in | `AGENTGDB_TRACE_CAPTURE=true`; metadata remains stored. Age-based turn purge is available through `DELETE /api/traces?before=<unix-ms>`. |
| Trace retention | Optional | `AGENTGDB_TRACE_RETENTION_DAYS=1..3650` purges expired turns and sessions at startup; unset disables automatic cleanup. |
| Human approval | Not implemented | MCP call fails explicitly. No approval record or action gate exists. |
| Execution freeze / subprocess halt | Not implemented | No general process controller is wired into the proxy. |
| 240-hour replay | Not verified | No end-to-end evidence of long-duration deterministic replay. |
| Zero-cost fork/resume | Partial/unverified | In-memory fork state and cached response path are not a complete deterministic execution replay. |
| Secret leak interception before execution | Not verified | Presence of a scanner module does not prove all prompts, logs, or tool paths are gated. |
| Virtual filesystem | Isolated module | Not wired into agent I/O; path containment is checked, but it is not a sandbox. |
| Cryptographic attestation / PR evidence | Not suitable for trust claims | Current helper does not establish trusted identity or prove that changes were in scope. |
| 1,000-developer evaluation | Withdrawn | Former report was generated from synthetic random scores and fabricated feedback. |

Do not upgrade these statuses based on unit tests alone. Any move to “enforced” or “production-ready” requires end-to-end tests through the actual agent execution path and an independent security review.
