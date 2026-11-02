# Local candidate validation — 2026-11-02

**Result: local gates passed on macOS; release remains blocked.**

## Candidate and environment

- Repository branch: `codex/agentgdb-usability-safety-fixes`.
- Git HEAD: `e413c609b84de687b51a9fab7e41b254c7ba07fa` plus the uncommitted working-tree changes present during validation. The worktree has since received additional release-validator and documentation changes; current in-place verification is recorded below.
- Platform: macOS ARM64, Darwin 27.0.0.
- Runtime: Node.js 22.23.4, 24.22.2, and 26.13.0 for current clean-copy validation on macOS ARM64. Node.js 25.4.0 was used for an earlier in-place check, but it is outside the declared supported runtime matrix and is not release evidence.
- The clean-copy run used a fresh temporary copy excluding `.git`, `node_modules`, and `.agentgdb`.

## Results

In an earlier fresh temporary copy of the candidate, before the current release-validator, demo-response, and runtime-matrix changes, the following sequence passed under Node.js 22.23.4:

```text
npm ci                         added 179 packages
npm audit --audit-level=moderate  0 vulnerabilities
node --test                    82 passed, 0 failed, 1 Windows-only test skipped
npm run build:css              passed
```

The clean-copy command used `node --test` directly after installing dependencies, not `npm test`; both execute the same Node test runner here. The Windows-only launcher test was skipped on macOS.

In the working checkout under Node.js 25.4.0, before the later release-evidence validator test was added:

- `npm test`: 83 tests total, 82 passed, 0 failed, and 1 Windows-only test skipped.
- `npm run build:css`: passed.
- `npm audit --audit-level=moderate`: 0 vulnerabilities.
- `git diff --check`: passed.
- `npm run validate:release`: correctly failed closed because `docs/release-evidence.json` is missing.
- An isolated local-daemon smoke rendered the dashboard in the in-app browser with the session-inspector title and workspace setup fields; the page showed the expected operator-token-required state before authentication. The browser's `workspace_id.js` module is served as `application/javascript`. A separate authenticated HTTP smoke created a workspace, rejected a create-only registration using its ID, verified the original name remained unchanged, and verified `createOnly` was not persisted. This exercises rendering and the server boundary, not a complete interactive form submission or a user pilot.
- The integration suite injects a candidate watcher startup failure and verifies that the selected project and prior observer remain active.
- A unit test simulates `win32` path comparison and verifies mixed-case forbidden paths are denied; this does not replace Windows runtime validation.
- POSIX integration coverage verifies database initialization refuses symlinked state directories and database files; Windows ACL behavior remains unverified.
- Dashboard regression coverage verifies a visible WebSocket connection state and a retry delay capped at 30 seconds.
- Redaction coverage verifies nested authorization, API-key, cookie, AWS secret-key, generic Bearer, approval action, decision-reason, execution-summary, and captured-payload values are masked before persistence. Unknown formats remain possible; this is not a DLP guarantee.

After the release-evidence URL validation changes, the current in-place worktree was rechecked under Node.js 25.4.0:

```text
npm test                        83 passed, 0 failed, 1 Windows-only test skipped (84 total)
npm run build:css               passed
npm audit --audit-level=moderate 0 vulnerabilities
git diff --check                passed
```

The release-evidence unit file, including public/local-address URL cases, passed all 14 tests. The managed-MCP integration file passed all five tests, including assertions that the synthetic demo endpoint returns its event over HTTP and reports that it was not persisted. A fresh local browser tab loaded the dashboard, then a click on **Run local demo** rendered the synthetic event in the timeline without an operator token; the status confirmed no project files, upstream API, or trace database were used. The workspace form itself was not submitted in this browser smoke because it requires entering an operator token; authenticated setup remains covered by integration tests.

After updating the declared support contract, CI matrices, and transcript pre-registration validation, the current source was synchronized to the three clean-copy installations built with `npm ci` and the full verification sequence was rerun on macOS ARM64:

| Node.js | npm | `npm ci` | Audit | CSS build | Full suite |
|---|---:|---|---|---|---|
| 22.23.4 | 10.9.9 | Pass (179 packages) | 0 vulnerabilities | Pass | 84 passed, 1 Windows-only skip |
| 24.22.2 | 11.19.1 | Pass (179 packages) | 0 vulnerabilities | Pass | 84 passed, 1 Windows-only skip |
| 26.13.0 | 11.20.0 | Pass (179 packages) | 0 vulnerabilities | Pass | 84 passed, 1 Windows-only skip |

The managed-MCP integration suite also passed 5/5; it verifies malformed-only and unsupported transcripts are rejected before project registration, correcting the transcript allows the same create-only workspace ID to be retried, and transient validation flags are not stored in workspace settings. After adding the last two non-persistence assertions, this focused integration suite was rerun successfully under Node 22.23.4. All current-tree verification above is macOS-only and uncommitted. Linux and Windows runtime behavior and hosted CI remain unverified.

After adding fail-closed guards for complete approval payloads, the in-place Node.js 25.4.0 full suite passed with 86 tests, 0 failures, and 1 Windows-only skip. The focused managed-MCP and approval-policy suites passed 15/15; the proxy integration suite passed 5/5. Regression cases place secret-like text in resolved workspace context and verify neither action path creates a pending approval; the MCP case also verifies no file is written, and the proxy case verifies no tool call is returned for execution. `git diff --check` passed. The current host has no Docker/Podman or `act` runner, so Linux/Windows validation could not be performed locally. These results apply to the current uncommitted macOS worktree only and do not update the earlier three-runtime clean-copy results.

After adding the approval-context checks and both integration regressions, the latest source was copied to clean directories excluding `.git`, `node_modules`, and `.agentgdb`. On macOS ARM64, each copy passed `npm ci` (179 packages), `npm audit --audit-level=moderate` (zero vulnerabilities), CSS build, and the full suite (86 passed, 0 failed, 1 Windows-only skip):

| Node.js | npm used | Install | Audit | CSS build | Full suite |
|---|---:|---|---|---|---|
| 22.23.4 | 11.9.0 | Pass | 0 vulnerabilities | Pass | 89 passed, 1 Windows-only skip |
| 24.22.2 | 11.9.0 | Pass | 0 vulnerabilities | Pass | 89 passed, 1 Windows-only skip |
| 26.13.0 | 11.9.0 | Pass | 0 vulnerabilities | Pass | 89 passed, 1 Windows-only skip |

These are current-tree, clean-copy checks across Node versions on macOS only. The package's platform matrix still requires actual Linux and Windows runners; simulated Windows path tests and the skipped Windows launcher test do not prove those environments.

`npm pack --dry-run --json` reports a 31-file, 57,112-byte archive containing the CLI entry points, public dashboard assets, runtime source, package metadata, and README. The package-content regression passes and confirms test suites, workflows, examples, and evaluation documents are omitted. At that earlier checkpoint, the allowlist included `LICENSE` but no license file had yet been selected or added. This was a packaging dry run, not a publication or installed-package smoke test.

An isolated Node 22.23.4 install smoke packed the artifact, installed it with production dependencies only into a temporary prefix, and verified the `agentgdb help` command, daemon health endpoint, dashboard response, and privacy-safe demo response (`persisted:false`, `synthetic-demo`). It then connected an MCP client to the installed `agentgdb-mcp` executable, read an allowlisted fixture, and completed a write only after authenticated operator approval in a disposable workspace. The repeatable check is now `npm run smoke:package` and is wired into both CI and release matrices. This local macOS run verifies that packaged path for one runtime; it does not verify model-driven execution, a registry publish, Linux/Windows behavior, hosted CI, or license readiness.

## Previous dashboard verification, before scope-policy hardening

After the responsive layout and no-token onboarding changes, the full suite and installed-package smoke passed under each declared Node major on macOS ARM64 using the current in-place checkout and its installed dependencies:

| Node.js | Full suite | Installed-package smoke |
|---|---|---|
| 22.23.4 | 92 passed, 0 failed, 1 Windows-only skip (93 total) | Pass |
| 24.22.2 | 92 passed, 0 failed, 1 Windows-only skip (93 total) | Pass |
| 26.13.0 | 92 passed, 0 failed, 1 Windows-only skip (93 total) | Pass |

The package smoke covers packed install, CLI, daemon, dashboard, privacy-safe demo, allowlisted MCP read, and authenticated approved write. The local browser preview showed the dashboard-connected state, neutral operator-token guidance, disabled workspace selector, and demo action without an authentication error. Dashboard regression tests cover the 900px CSS breakpoint and no-token guidance; a rendered phone/tablet viewport audit has not been performed. These are not clean-copy installs or Linux/Windows CI. Hosted checks remain unverified, and this candidate is still uncommitted.

## Latest scope-policy validation

After restricting the path-rule grammar to exact relative paths, `directory/**`, and explicit `**`, and making invalid stored policies fail closed, the full suite and packed-install smoke passed on macOS ARM64 across each declared Node major using the current in-place checkout:

| Node.js | Full suite | Installed-package smoke |
|---|---|---|
| 22.23.4 | 93 passed, 0 failed, 1 Windows-only skip (94 total) | Pass |
| 24.22.2 | 93 passed, 0 failed, 1 Windows-only skip (94 total) | Pass |
| 26.13.0 | 93 passed, 0 failed, 1 Windows-only skip (94 total) | Pass |

The policy regression rejects `src*`, `src/*`, and nested wildcard forms during registration and denies actions for invalid legacy rules. At that checkpoint, exact paths also matched descendants; the follow-up below fixes and validates that behavior. This is in-place macOS evidence, not a clean-copy or Linux/Windows result. Hosted CI, a rendered multi-viewport review, independent security review, and observed user pilot remain outstanding; the candidate is uncommitted.

## Exact-path rule correction

After correcting the matcher so exact allow/deny entries match only the named normalized path (directory recursion is granted only by `<directory>/**`), the full suite passed on an ARM64 macOS host with x64 Node binaries (Darwin x64 process), for Node 22.23.4, 24.22.2, and 26.13.0: each run reported 95 total, 94 passed, 0 failed, and 1 Windows-only skip. The installed-package smoke passed on each Node version, covering the packed CLI, daemon, dashboard, demo, MCP read, and authenticated approved write. A stdio MCP integration assertion verifies an exact-only `src` rule denies a write to `src/exact-rule-child.txt` before an approval is queued or a file is created; the managed-MCP integration file passed 6/6 on Node 22.23.4. These were in-place runs using existing installed dependencies; they are not clean-copy checks, hosted CI, or Linux/Windows validation. `git diff --check` passed. The older table above is retained as historical evidence for the prior candidate checkpoint.

## Narrow viewport first-run and layout check

An in-app browser loaded the local dashboard at a narrow viewport. The no-token onboarding state and privacy-safe demo were visibly usable; the demo rendered a synthetic event and stated it did not use workspace files, an upstream API, or trace persistence. Using a temporary home and disposable workspace, the actual setup form activated a workspace and loaded one transcript event. Submitting a malformed JSONL transcript showed a clear parse error and did not replace the active workspace. Visual inspection found the inspector's default `<pre>` text clipped horizontally; the narrow-screen CSS now wraps while preserving line breaks, and a regression assertion covers the rule. After this change, the dashboard product-copy suite passed 4/4, the Node 22.23.4 full suite passed with 95 total, 94 passed, 0 failed, and 1 Windows-only skip, the CSS build passed, and the installed-package smoke passed. This was one narrow viewport check, not a desktop/tablet matrix, accessibility audit, or platform-independent rendering test.

## Startup maintenance audit logging

Startup now logs the configured trace-retention window, deleted turn/approval/session counts, and pending approvals rejected because a prior daemon run ended. The retention unit fixture verifies each category separately, and restart integration verifies one interrupted approval is logged as rejected. On Node 22.23.4, `test/unit/safety_regressions.test.js` plus `test/integration/managed_mcp.test.js` passed 16/16. After the change, the full suite passed on Node 22.23.4, 24.22.2, and 26.13.0 with 95 total, 94 passed, 0 failed, and 1 Windows-only skip per run; the packaged install smoke passed on Node 22.23.4. This is local macOS verification; it does not establish hosted or cross-platform behavior.

## Loopback live-event authentication

Loopback WebSocket clients now receive an authentication challenge and are added to the session/approval event broadcast only after presenting the operator token. Inbound frames are capped at 4 KiB. The integration test starts a live transcript watcher and confirms an unauthenticated socket receives no appended session event while a token-authenticated socket does; invalid tokens and oversized frames are rejected. At this checkpoint, dashboard source regression checks covered the initial socket lifecycle. `node --test test/integration/remote_auth.test.js test/unit/dashboard_product_copy.test.js` passed 8/8, the full `npm test` suite passed with 95 passed, 0 failed, and 1 Windows-only skip (96 total), `npm run build:css` passed, and `npm run smoke:package` passed on the current macOS host. This is an uncommitted local result; Linux/Windows CI, independent security review, pilot feedback, and release-bound evidence remain missing.

At the WebSocket-auth checkpoint, the full suite was rerun with Node 22.23.4, 24.22.2, and 26.13.0 using `npx node@<major> --test`; each run passed 95 tests, failed 0, and skipped the same 1 Windows-only test (96 total). This verifies three Node runtimes on this macOS host only; it is not a clean install for each runtime, nor a substitute for Linux/Windows CI.

The installed-package smoke was also rerun using Node 22.23.4 and passed packed installation, CLI, daemon, dashboard, demo, MCP read, and authenticated approved write. This package smoke remains macOS-only.

## Dashboard trace-deletion control

The dashboard now exposes a collapsed **Stored data and deletion** panel with a past-cutoff field, optional session-summary deletion, operator-token gating, an irreversible-action confirmation, and explicit WAL-checkpoint retry guidance. The deletion endpoint's existing integration test verifies transactional row removal, summary behavior, incomplete checkpoint reporting while a reader pins the WAL, and successful idempotent retry. Dashboard source regressions cover the cutoff guard, confirmation, authenticated request path, and retry message. At this checkpoint, focused dashboard/privacy tests passed 7/7; the full suite passed 96 tests, failed 0, and skipped 1 Windows-only test (97 total); package smoke passed. An isolated browser load rendered the new collapsed control and no-token setup state; no destructive delete was clicked in that browser check. This remains macOS-only and does not replace hosted cross-platform validation.

## Operator-token change revocation

The dashboard now closes its current WebSocket whenever the operator-token field changes or is cleared, and opens a new socket only when a non-empty replacement token is available. The focused dashboard and remote-auth suites passed 9/9; the full suite passed 96, failed 0, and skipped 1 Windows-only case (97 total); `npm run smoke:package` passed. These checks ran on Node 25.4.0 on macOS; Linux and Windows remain unverified.

The current lockfile passed `npm audit --audit-level=moderate` with zero reported vulnerabilities. This audit result is local dependency metadata evidence and does not substitute for hosted CI or security review.

## Release evidence tag binding

The prior release instructions required a manifest to contain the SHA of the commit that also contained that manifest, which is self-referential and cannot be reliably produced. The gate now carries JSON evidence in an unsigned annotated tag message created after the candidate commit. The extraction utility verifies the tag object type, tag name, target commit SHA, evidence tag/SHA fields, bounded message size, and strict JSON-only message before writing an ignored generated manifest for the existing validator. Fixture tests prove extraction does not change the candidate SHA, run both CLI tools end to end, verify the generated file is ignored, and reject a lightweight tag, a target-SHA mismatch, and extra message text. Focused release-evidence tests passed 22/22; the full current-source suite passed with 101 passed, 0 failed, and 1 Windows-only skip (102 total) before the added CLI integration assertion. No release tag or real evidence was created; the hosted tag workflow remains unrun.

## Managed command process lifecycle and MCP error semantics

The managed MCP adapter now invokes `runManagedCommand` rather than `execFile`. Timeout, caller cancellation, and output overflow initiate POSIX process-group termination or Windows `taskkill /T /F`; a nonzero Windows termination result is treated as unconfirmed and returned as failure. Command execution failures use MCP error status. A unit suite verifies timeout and cancellation terminate a descendant and output overflow fails; the official MCP integration starts a descendant, approves the command, verifies timeout is reported as an MCP error, then checks that the descendant did not write its delayed marker.

On the current macOS working tree at HEAD `e413c609b84de687b51a9fab7e41b254c7ba07fa` plus uncommitted changes, `node --test` under Node 22.23.4, 24.22.2, and 26.13.0 reported 108 tests total, 107 passed, 0 failed, and 1 Windows-only skip on each runtime after the MIT distribution and release-notes regressions were added. The packed-install smoke passed under Node 22.23.4, 24.22.2, and 26.13.0 for CLI, daemon, dashboard, demo, MCP read, and authenticated approved write. Each smoke installed the packed tarball into a fresh temporary npm prefix on the same macOS host; this is not a clean-machine or cross-platform install. `npm audit --audit-level=high` found 0 vulnerabilities; `git diff --check` passed. These are local macOS results. The Windows process-tree branch, Linux behavior, clean platform installs, and hosted CI are not verified by these runs.

After the owner selected MIT and the package metadata plus `LICENSE` were added, the release validator was rerun against this HEAD and exited 1 with `Release blocked: missing docs/release-evidence.json.` The packaging and release-evidence tests confirm the license prerequisite itself is satisfied. No current release evidence was created or bound to this working tree. The candidate remains uncommitted; the GitHub draft PR points to an older remote commit and no Actions runs were listed during this check. A fresh real-agent run was not completed: the installed `codex --version` probe produced no output after 17 seconds and was stopped; no model task was started. The previously documented bounded Codex run predates the current process-runner change and remains uncommitted evidence. MIT has been selected and added to `package.json`, the lockfile root metadata, and `LICENSE`. A packaging test checks that these agree and that `LICENSE` is included in the tarball. Independent security review, observed developer pilot, clean Linux/Windows validation, current real-agent evidence, and release-commit evidence remain required. Keep the release status blocked.

## MIT distribution terms and release-notes draft

The repository owner selected MIT in response to the release-license question. `package.json` and the root lockfile metadata declare `MIT`; `LICENSE` contains the MIT terms and the public repository-owner handle, and the package artifact regression verifies their consistency and inclusion. The release validator's root license check passes. The packed-install smoke passed after this change on Node 22.23.4, 24.22.2, and 26.13.0, each using a fresh temporary npm prefix on this macOS host.

`docs/RELEASE_NOTES_DRAFT.md` now records product scope, runtime/platform verification limits, bypasses and sandbox limits, capture and deletion behavior, and outstanding release evidence. It is explicitly unreviewed and must be reconciled to the exact release commit. The release evidence validator still blocks because no exact-release evidence manifest exists.

## Limits and next evidence required

This is macOS-only evidence for an uncommitted local candidate. It is not a release commit, remote CI result, independent security review, or user pilot. Linux and Windows clean installs and test runs remain unverified. The real-agent run documented in [REAL_AGENT_RUN_2026-11-02.md](REAL_AGENT_RUN_2026-11-02.md) also remains bound to a local uncommitted candidate. Keep the release status blocked until the evidence in [RELEASE_GATE.md](../RELEASE_GATE.md) is collected for one exact commit.
