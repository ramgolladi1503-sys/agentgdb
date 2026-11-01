# AgentGDB release gate

**Current release status: BLOCKED — experimental local use only.**

A release may be described as production ready only when every gate below has evidence tied to the exact release commit. Unit tests, simulated personas, local MCP protocol tests, and repository documentation do not substitute for the named evidence. The release owner records the commit SHA and links the evidence before changing this status.

## Required evidence

1. **CI:** the required GitHub Actions workflow passes on the release commit, including `npm ci`, `npm audit --audit-level=moderate`, CSS build, and the full test suite.
2. **Supported platforms:** clean install and documented smoke test pass on macOS, Linux, and Windows with Node 22. Record OS version, Node version, and output for each platform.
3. **Real agent path:** at least one named supported coding-agent host performs a bounded disposable-workspace task through the AgentGDB MCP adapter. Verify an allowlisted read, an approved write, an approved command, a denied command, timeout, daemon restart, and cancellation. Confirm the host's alternate filesystem and terminal tools are disabled for this run. Record the host/version and evidence; MCP discovery alone does not satisfy this gate.
4. **Security review:** an independent reviewer examines workspace/path races, process command policy, approval identity and recovery, auth, secret retention, hostile transcript inputs, and deletion behavior. Record reviewer, date, commit SHA, findings, and disposition. Critical/high findings block release.
5. **Release notes:** notes state supported host/platform versions, known bypasses and sandbox limits, storage/capture defaults, deletion limits, and all known unverified capabilities. Withdrawn synthetic evaluation claims must not be repeated.
6. **Operator readiness:** a real-user pilot validates install, setup, approval comprehension, data deletion, and recovery. Report participant count/method accurately; do not imply a larger survey than was run.

## Current evidence snapshot (2026-11-02)

- Local macOS test suite: 44/44 pass on Node 25 and Node 22.23.4. A fresh temporary copy also passed `npm ci`, CSS build, all 44 tests, and audit on Node 22.23.4.
- `npm audit --audit-level=moderate`: zero reported vulnerabilities.
- Dashboard stylesheet build passes and uses local assets.
- Claude Code CLI connected to the AgentGDB stdio MCP server and discovered it. No model-driven action task was run.
- Captured single-turn playback passed a restart integration test, validated the stored input/output hashes, and reported zero external calls. Multi-turn agent replay is unverified.
- Claude Code reports no logged-in account on this machine; no model-driven task was attempted. Missing: green remote macOS/Linux/Windows workflow on this revision, clean installs on Linux and Windows, model-driven host task, independent security review, and observed user pilot.
- Source changes are local and unpublished; the public draft PR still points to its earlier commit. This working candidate is not a release candidate because the required evidence above is missing.

## Release owner procedure

1. Review and commit the candidate changes; identify the exact commit SHA.
2. Require the repository CI workflow as a branch protection check and collect all platform results for that SHA.
3. Attach the real-agent run record and independent security review for that SHA.
4. Write release notes from verified behavior and current limitations.
5. Have the release owner verify every required item above. If any evidence is absent, keep the release experimental and do not publish a production-ready claim.
