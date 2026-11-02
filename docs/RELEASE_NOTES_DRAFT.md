# AgentGDB 1.0.0 — release-notes draft

**Status: draft for owner and maintainer review; not reviewed or approved for release. Do not publish or describe this candidate as production ready.**

## What this candidate does

AgentGDB is a local coding-agent session inspector with a supervised MCP tool adapter. It can watch a selected supported JSONL transcript, show observed session events, and expose workspace read, write, and exact-argument command tools. Mutating managed MCP actions wait for an authenticated operator decision. The dashboard includes an in-memory synthetic demo that uses no API key, workspace file, upstream request, or trace persistence. Captured single-turn playback returns stored, hash-checked inputs and outputs; it does not re-run an agent or make an upstream call.

## Supported hosts and platforms

The declared Node.js runtime majors are 22.x, 24.x, and 26.x. The current candidate's automated suite and packed-install smoke have been run locally on macOS for those Node majors. Linux and Windows clean-machine runs, hosted CI results, Windows storage ACL behavior, and Windows process-tree termination remain unverified. Agent compatibility is narrow: one bounded Codex CLI run is documented for an earlier uncommitted candidate; the current candidate needs a new real-agent run bound to its exact release revision. Claude Code and Gemini MCP discovery do not establish model-driven compatibility.

## Security, bypasses, and isolation limits

The dashboard binds to loopback by default. Non-loopback service binding requires a bearer token. Trace payload capture is disabled by default, though session metadata and usage fields are stored locally. Workspace path and symlink checks are application-level snapshots and remain vulnerable to same-user filesystem races. AgentGDB is not an operating-system sandbox. The MCP adapter mediates only calls made through its own tools; the proxy checks only supported calls sent through that proxy. An agent can bypass these paths if native filesystem/terminal tools or another endpoint remain enabled. Disable alternate tools when using the approval path.

Managed command approvals show the exact executable identity and argument list. Timeouts, caller cancellation, and output overflow request process-tree termination, but detached descendants may escape. A shared local operator token does not protect against a hostile process running as the same operating-system user. Credential redaction is pattern based and cannot guarantee detection of every secret.

## Storage and deletion

Trace payload capture is opt-in. Optional age-based retention and authenticated date-based deletion are available. Deletion removes selected database rows and reports whether the SQLite WAL checkpoint completed; it cannot erase copied databases, filesystem snapshots, or backups. Keep capture disabled unless needed and verify backups and retention requirements separately.

## Release status

This draft does not represent a completed release review. The exact-candidate hosted platform matrix, current-candidate real-agent run, independent security review, and observed developer pilot are still required. The owner selected MIT; `package.json`, the lockfile, and the repository `LICENSE` declare/include those terms. Do not publish the package or claim production readiness until the release gate is satisfied and this document is reviewed against the exact release commit.
