# AgentGDB usability and readiness audit

**Review date:** 2026-11-02  
**Revision reviewed:** `905d69401e373285e0d97b674bf9fb8504ea2b40`  
**Method:** Source/documentation review; no real developer panel was conducted.

## Opinion

AgentGDB targets a real problem, but it is not production ready. First make a clean local install useful, then verify security-sensitive claims across the actual agent execution path. Seven requested fixes have been applied in this branch; the scope gate remains explicitly advisory because this product does not mediate arbitrary filesystem or shell operations.

## The 1,000-developer report

The former `1000_DEV_EVALUATION_REPORT.md` is invalid as human research. Its script generated 1,000 fictional scores using `Math.random()`, hard-coded the recommendation rate, and included invented respondent-like quotes. No respondent dataset, recruitment, consent, or instrument was present. The report is retained with a withdrawal notice for provenance; its claims must not be cited. The former panel audit also lacks artifacts proving its claimed human participation and remains unverified.

## Changes made

1. New installs have an empty project registry and no guessed transcript or project paths.
2. Server binds to `127.0.0.1` by default; non-loopback binding requires a bearer token checked on API, static, and WebSocket requests. Wildcard CORS was removed.
3. Drift status is `UNKNOWN` when unavailable. MCP scope checks use the configured watcher scope and clearly report `ADVISORY_ONLY`; human approval fails explicitly instead of returning a fake pending message.
4. VFS rejects root escapes and symlinked external ancestors, validates all paths before commit, stages replacement writes, and uses rename for per-file replacement. Multi-file atomicity is not promised.
5. Request/response payload persistence is opt-in via `AGENTGDB_TRACE_CAPTURE=true`; SQLite files are created with restrictive permissions where supported, API responses omit stored payload fields, and an age-based purge endpoint exists.
6. README claims were narrowed, benchmark generation disabled, and a feature-status table added.
7. `npm test` now uses Node's built-in test runner.

## Remaining limitations

- Scope checks are advisory; they cannot stop an agent from acting. Enforcement requires routing actual tool/file operations through a trusted controller.
- Remote auth is a basic shared bearer-token check, not a full account/session system. The dashboard browser cannot set auth headers by itself in remote mode; use a trusted local reverse proxy/client setup. Do not expose publicly without further review.
- Metadata such as session ID, model, token count, and latency is still persisted even when payload capture is disabled.
- The approval system remains unavailable by design until a real durable approval gate exists.
- VFS file replacements are staged per file, but a failure across multiple files may still leave a partial multi-file commit.
- No 1,000-person survey has been run. The recommended next step is an observed 8–12 person usability pilot after the first-run workflow is stable.

## Real-user study plan

Recruit 8–12 developers who actively use long-running coding agents. On a clean machine, ask each to install/start, connect a fixture transcript, interpret an event, distinguish alerting from blocking, find/delete stored data, and recover from a missing transcript. With consent, record completion, time, errors, help required, and comprehension of safety limits. Publish the instrument and anonymized results. Consider a larger survey only after this pilot demonstrates a usable product and a meaningful target population is defined.
