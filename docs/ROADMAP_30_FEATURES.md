# Archived 30-feature concept list

**Archived and inactive.** This file is not a delivery roadmap, implementation checklist, or evidence of capability. The former checked boxes were unsupported and have been removed. Use [FEATURE_STATUS.md](FEATURE_STATUS.md) for the source-backed implementation state.

## Current product scope

AgentGDB is an experimental local coding-session inspection and supervised-tool prototype. Its currently implemented, narrowly scoped workflow is:

1. Start the local dashboard and try an in-memory synthetic demo without an API key.
2. Register a workspace with an explicit relative path allowlist and optionally attach a recognized JSONL transcript for advisory observation.
3. Connect an MCP client to AgentGDB's stdio adapter. The adapter mediates only its own file-read, file-write, and exact-argument command tools. Writes and commands require durable operator approval; path and command policies are checked before execution.
4. Inspect captured single-turn proxy results only when complete payloads and matching hashes are available. Playback returns stored results and does not re-run an agent.

Clients can bypass the adapter through alternate tools or endpoints. Path checks are not an operating-system sandbox, and transcript watching is observational. A bounded authenticated Codex action run passed for a mediated read, approved write, approved command, and denied command, but the full real-agent release gate remains incomplete. Review the feature-status table and [run record](evaluation/REAL_AGENT_RUN_2026-11-02.md) for details and remaining gaps.

## Retired concepts

The former list proposed 30 capabilities spanning autonomous interception, long-horizon replay, automatic self-healing, broad agent discovery, mobile notifications, cloud synchronization, compliance attestations, and PR automation. Those proposals are not current product commitments and must not be described as implemented or verified. Reconsider them only after the current workflow passes clean installs on supported platforms, a real-agent end-to-end run, independent security review, and an observed developer pilot.
