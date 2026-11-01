# AgentGDB usability and readiness audit

**Review date:** 2026-11-02
**Revision reviewed:** working tree on `codex/agentgdb-usability-safety-fixes`, based on `7eec651`; local implementation not yet published.
**Method:** Source/documentation review and local automated tests; no real developer panel or independent security review was conducted.

## Opinion

AgentGDB targets a real problem, but it is not production ready. This working tree adds a synthetic first-run demo, transcript parse feedback, a narrow proxy-side tool-call gate, an official MCP stdio adapter that executes its own read/write/command tools after policy and approval checks, captured single-turn playback, credential-pattern redaction, and a cross-platform CI definition. The managed adapter only mediates its own tools; clients must disable alternate native tools, and the path checks are not an OS sandbox. Local tests are evidence for these specific paths, not readiness certification.

## The 1,000-developer report

The former `1000_DEV_EVALUATION_REPORT.md` is invalid as human research. Its script generated 1,000 fictional scores using `Math.random()`, hard-coded the recommendation rate, and included invented respondent-like quotes. No respondent dataset, recruitment, consent, or instrument was present. The report is retained with a withdrawal notice for provenance; its claims must not be cited. The former panel audit also lacks artifacts proving its claimed human participation and remains unverified.

## Changes made

1. New installs have an empty project registry and no guessed transcript or project paths.
2. Server binds to `127.0.0.1` by default; non-loopback binding requires a bearer token checked on API, static, and WebSocket requests. Wildcard CORS was removed.
3. Drift status is `UNKNOWN` when unavailable. MCP scope checks remain advisory. The OpenAI-compatible proxy now checks a narrow supported tool-call subset and denies unknown formats, paths, and symlink escapes before returning calls.
4. VFS rejects root escapes and symlinked external ancestors, validates all paths before commit, stages replacement writes, and uses rename for per-file replacement. Multi-file atomicity is not promised.
5. Payload capture remains opt-in; common credential patterns are redacted before persistence. Captured turns include schema/engine versions and hashes; incomplete or mismatched traces fail replay explicitly. Fixture playback is verified after daemon restart and reports zero upstream calls; this is stored-turn playback, not agent re-execution.
6. Mutating tool calls wait on a durable, token-authenticated approval record. Timeout and server restart close the proposal without returning it to the client.
7. Dashboard workspace/transcript setup, synthetic demo, an end-to-end official MCP stdio test, Claude Code CLI MCP discovery, auth tests for HTTP/static/WebSocket, hostile-transcript rendering checks, trace-deletion integration tests, and a Node 22 Linux/macOS/Windows CI matrix with npm audit are present. Dashboard CSS/fonts are bundled locally. Trace purging is transactional and can remove old session summaries when no newer turns remain. The remote matrix has not yet run; Claude Code has not performed a model-driven edit through the adapter.

## Remaining limitations

- Proxy checks can be bypassed by any client configured to another endpoint. No independent tool runtime or OS sandbox exists; symlink validation is a race-prone snapshot check.
- Tool schema support is intentionally narrow. Named real coding-agent clients, cancellation under real host shutdown, browser accessibility, clean OS installs, and upstream timeout behavior still need validation.
- Remote auth is a basic shared bearer-token check, not a full account/session system. The dashboard browser cannot set auth headers by itself in remote mode; use a trusted local reverse proxy/client setup. Do not expose publicly without further review.
- Metadata such as session ID, model, token count, and latency is still persisted even when payload capture is disabled.
- Trace deletion can remove rows from the active SQLite database, but it cannot erase filesystem snapshots, copied databases, or backups.
- The approval token is a local friction barrier, not protection from a hostile process running with the same OS-user access.
- Credential redaction is pattern based and can miss novel secret formats. It is not a data-loss-prevention guarantee.
- VFS file replacements are staged per file, but a failure across multiple files may still leave a partial multi-file commit.
- No 1,000-person survey has been run. Any simulated agent personas must be reported as synthetic review, not developer opinions. The recommended next step is an observed 8–12 person usability pilot after the first-run workflow is stable.

## Next work in priority order

1. Run the Node 22 CI matrix on macOS, Linux, and Windows; fix platform failures before release.
2. Install on clean macOS, Linux, and Windows machines. Connect named coding-agent clients only through the AgentGDB MCP tools with native filesystem/terminal tools disabled. Verify reads, writes, exact commands, deny, approval, timeout, restart, and cancellation behavior from the user's perspective.
3. Obtain an independent security review focused on same-user approval bypass, workspace/path races, tool-schema ambiguity, secret retention, and remote authentication.
4. Run an observed 8–12 developer pilot on clean machines. Measure setup success, time to first useful event, policy comprehension, approval clarity, and recovery from common errors. Expand the sample only after the workflow and target population are stable.
5. Build multi-turn replay with immutable model/tool fixtures only after single-turn playback behavior and storage semantics are validated.

## Real-user study plan

Recruit 8–12 developers who actively use long-running coding agents. On a clean machine, ask each to install/start, connect a fixture transcript, interpret an event, distinguish alerting from blocking, find/delete stored data, and recover from a missing transcript. With consent, record completion, time, errors, help required, and comprehension of safety limits. Publish the instrument and anonymized results. Consider a larger survey only after this pilot demonstrates a usable product and a meaningful target population is defined.
