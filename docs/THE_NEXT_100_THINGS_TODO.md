# AgentGDB historical engineering backlog

> **Unverified backlog:** tasks below are proposals, not implemented capabilities or a delivery commitment. Check [FEATURE_STATUS.md](FEATURE_STATUS.md) for source-backed status. No industry leadership or production-readiness claim is made.
>
> **Status: archived and frozen.** Do not treat these ideas as active work or expand the feature set until the core local supervised-session workflow passes supported-platform installs, a real coding-agent task, independent security review, and an observed developer pilot.

---

## Pillar 1: Kernel & Runtime Interception Engine (Tasks 1–18)
1. **PTrace/Process Wrapper Daemon**: Add OS-level process tracing for child agent CLI commands (`codex`, `antigravity`, `openhands`) to catch filesystem writes before disk flush.
2. **Deterministic Virtual Mock Filesystem**: Create an in-memory virtual overlay filesystem (VFS) to test agent file mutations safely before committing them to real disk.
3. **HTTP/2 & gRPC Wire Protocol Reverse Proxy**: Expand proxy support from HTTP/1.1 SSE to streaming gRPC for enterprise agent orchestrators.
4. **Sub-millisecond Token Bucket Limiter**: Implement fine-grained sliding-window token throttling per minute/hour.
5. **Dynamic Cost Tracker by Model**: Integrate real-time token pricing tables (GPT-4o, Claude 3.5 Sonnet, Gemini 1.5/2.0, DeepSeek V3/R1) with instant USD cost computation.
6. **Async Tool Pause/Resume Locks**: Implement atomic mutexes allowing the UI to freeze agent subprocesses mid-command.
7. **Signal Interceptor (`SIGSTOP` / `SIGCONT`)**: Allow instant shell pause of long-running `bash_run` child processes.
8. **Binary Data & Image Artifact Caching**: Support multimodal payload storage (screenshots, diagrams, PDFs) within SQLite.
9. **Streaming Context Window Re-tokenizer**: Fast BPE/tiktoken parser running on-the-fly to calculate exact token usage per message turn.
10. **Dead Memory Garbage Collector**: Automatically identify tool dumps older than $K$ turns that are never referenced again and suggest compression.
11. **Tool Execution Dry-Run Simulator**: Intercept shell commands and run them inside a disposable sandbox container before running on host.
12. **Environment Variable Airlock**: Sanitize `.env` variables before passing them into the agent's subprocess execution scope.
13. **Local SQLite Connection Pooling**: Implement auto-vacuuming and WAL maintenance for SQLite stores exceeding 10GB.
14. **Local DuckDB Analytics Engine**: Embed DuckDB for OLAP queries on historical drift metrics across millions of agent turns.
15. **Crash Recovery & State Hydration**: On daemon restart, automatically restore in-flight session streams from the last written byte.
16. **Dynamic Port Conflict Allocator**: Auto-bind to available ports if `:9099` is occupied and broadcast the active address.
17. **TCP Socket Hook for Non-HTTP Agents**: Create a local TCP proxy for raw socket-based agent protocols.
18. **Kernel Event Poller (kqueue on macOS, epoll on Linux)**: Replace fs.watch polling with native OS kernel notification events.

---

## Pillar 2: Semantic Scope Invariant & Drift Detection (Tasks 19–35)
19. **On-Device ONNX Embedding Engine**: Embed `nomic-embed-text` locally to calculate turn-by-turn cosine similarity to the declared goal.
20. **Dynamic Cosine Drift Thresholding**: Trigger drift alarms when semantic similarity to the active goal drops below configurable thresholds (e.g., 0.70).
21. **Tree-sitter AST Syntax Parser (Python/TS/Go/Rust)**: Parse modified files to distinguish cosmetic comments from structural AST logic changes.
22. **Blast Radius Dependency Graph Generator**: Build local static call-graphs to detect when an agent touches a file that breaks downstream consumers.
23. **Forbidden Regex Path Traps**: Expand path matching to support glob and regex expressions (e.g. `!**/*.spec.ts`).
24. **Stagnation Entropy Scorer**: Compute entropy scores over consecutive tool outputs; flag loops where output variance is near-zero.
25. **Self-Soothing Markdown Loop Trap**: Enforce hard limits on consecutive documentation edits when functional code remains unchanged.
26. **Circular Dependency Warning**: Detect when an agent modifies File A to satisfy File B, then modifies File B breaking File A.
27. **Test Assertion Deletion Trap**: Parse Git diffs to specifically detect when an agent deletes `assert` statements or test cases to artificially pass CI.
28. **Fake Mock Detector**: Flag when an agent mocks internal business logic instead of mocking external network boundaries.
29. **Prompt Injection Boundary Sentry**: Scan user input and tool outputs for adversarial jailbreak payloads.
30. **Automated Scope Extraction from PR Descriptions**: Use local SLM to extract implied invariant contracts from GitHub PR bodies.
31. **Multi-turn Drift Trend Forecasting**: Plot a projected drift vector over the next 10 turns to warn the developer *before* drift occurs.
32. **Scope Creep Budgeting**: Allow a configurable "leeway allowance" (e.g. 5% exploratory actions before triggering alerts).
33. **Context Truncation Alert**: Warn when the agent's context window exceeds 80% capacity and critical system prompts risk truncation.
34. **Hallucinated Package Import Trap**: Cross-reference newly introduced `import` statements against `package.json` / `requirements.txt`.
35. **Silent Fallback Detector**: Trap Python `try...except: pass` or JavaScript `.catch(() => {})` blocks added by the agent to hide broken code.

---

## Pillar 3: 240-Hour Time-Travel Replay & Branching (Tasks 36–50)
36. **Interactive 240-Hour Timeline Scrubber**: Build a 60fps timeline scrubber with zoomable time windows (minutes, hours, days).
37. **Git Worktree Branch Isolator**: When forking from Step $N$, automatically spin up an isolated `git worktree` so the main working directory is preserved.
38. **Zero-Cost Cached Response Invalidator**: Selectively invalidate specific cached tool responses while retaining the rest of the branch history.
39. **Time-Travel Step Backward/Forward Controls**: Add step-by-step debugger buttons (Step Over, Step Into, Step Out) to the UI.
40. **Multi-Branch Execution DAG Visualizer**: Render branching execution trees using React Flow / D3 hierarchy graphs.
41. **Full-Disk Snapshot Checkpointing via CoW**: Use copy-on-write (APFS on macOS, Btrfs on Linux) for instant, zero-cost disk snapshots before every turn.
42. **Side-by-Side Trajectory Comparison**: Compare two forks side-by-side to identify the exact prompt divergence point.
43. **Timeline Bookmarking & Tagging**: Allow developers to annotate specific turns with tags (e.g. "broke here", "architecture decided").
44. **Autonomous Run Playback Speed Controls**: Replay historical agent sessions at 1x, 5x, 20x, or 100x playback speed.
45. **Flight Recorder Bundle Exporter (`.agdb`)**: Package SQLite traces, git patches, and system telemetry into a single sharable zip file.
46. **Flight Recorder Player (Web-based)**: Allow team members to open and inspect `.agdb` bundles in their browser without running a daemon.
47. **Automated Minimal Repro Synthesizer**: Given a 200-step failure, prune irrelevant steps to produce a minimal 5-step reproduction script.
48. **Branch Merge Back to Main**: Support taking a successful fork branch and applying its clean code changes back to the main workspace.
49. **Token Savings Calculator on Fork**: Display total accumulated dollars and tokens saved by replaying cached turns.
50. **Time-to-Failure Analytics**: Aggregate time-to-drift statistics across hundreds of runs to identify common failure timeframes.

---

## Pillar 4: Auto-Steering & Self-Healing Runtime (Tasks 51–65)
51. **Dynamic Steering Prompt Synthesizer**: On drift detection, synthesize an assertive course-correction prompt and inject it into the next LLM turn.
52. **Automated Rollback to Last Verified Checkpoint**: If tests fail 3 consecutive times, automatically rollback disk to the last green state.
53. **Agent Self-Reflection Intervention**: Force the agent to output a 3-bullet self-justification before approving high-risk tool calls.
54. **Subtask DAG Generator**: Automatically break down the active goal into a live checklist, marking items complete as code is written.
55. **Automatic Test-Suite Runner**: Run `pytest` or `npm test` in the background after every file write and report pass/fail deltas on the timeline.
56. **Adversarial Invariant Fuzzer**: Run localized property-based tests against newly generated agent code before letting the agent continue.
57. **Automated Patch Verification Gate**: Compare the agent's proposed patch against the initial prompt to verify all requirements are addressed.
58. **Human-in-the-Loop Clarification Channel**: Allow the agent to pause and submit a clarification question to the developer via the AgentGDB UI.
59. **Flaky Test Trap**: Detect when a test passes and fails intermittently across turns without corresponding code changes.
60. **Tool Execution Timeout Enforcer**: Kill and alert on commands that exceed specified execution timeouts (e.g. hanging tests).
61. **Deadlock & Infinite Wait Detector**: Alert when an agent process is blocked waiting on an unclosed socket or pipe.
62. **Memory Leak Sentry for Agent Subprocesses**: Monitor RSS memory consumption of child commands; abort processes before OOM kills.
63. **Multi-Model Consensus Arbiter**: On critical architectural steps, dispatch the prompt to 2 rival models (e.g. Claude + GPT) and halt if they disagree.
64. **Automatic Lint/Format Autofix**: Run Prettier or Black on agent code before committing turns to eliminate syntax churn.
65. **Failure Root-Cause Explainer**: Use a fast local model to generate a plain-English explanation of why a specific step derailed.

---

## Pillar 5: Developer Experience, TUI & Notifications (Tasks 66–80)
66. **Terminal Headless TUI (`agentgdb top`)**: Build an interactive curses/Textual/Ink terminal interface for split tmux panes.
67. **Native macOS Menu Bar / System Tray App**: A lightweight status icon in the OS menu bar displaying active agent status.
68. **Real-Time Sound Synthesis / Chimes**: Play distinct retro audio cues for "Turn Success", "Breakpoint Hit", and "Drift Alert".
69. **Desktop Notification Dispatcher (macOS/Linux/Windows)**: Native OS alerts when an overnight loop needs human intervention.
70. **Mobile Webhook Relay (Telegram Bot)**: Two-way Telegram bot allowing developers to review and approve tool executions from their phone.
71. **Discord Webhook Alert Dispatcher**: Send drift embeds with diff snippets to team Discord channels.
72. **Slack Block-Kit Notification Bridge**: Interactive Slack messages with "Resume", "Edit", and "Abort" buttons.
73. **NTFY.sh Integration**: Zero-setup push notifications to mobile devices via the free NTFY protocol.
74. **Dark Mode / Cyberpunk High-Contrast UI Themes**: Custom color themes optimized for OLED screens and late-night debugging.
75. **Live Token Burn Velocity Meter**: Gauge showing real-time token spend per minute ($/min) with a visual speedometer needle.
76. **Keyboard Navigation Shortcuts (Vim / Emacs keys)**: Navigate timeline turns with `j`/`k`, inspect with `Enter`, fork with `f`.
77. **Split-Screen Unified Side-by-Side Diff Viewer**: Syntax-highlighted side-by-side diffs with inline comments and change markers.
78. **Command Line Filter & Search (`agentgdb grep`)**: Search across all historical agent turns and tool outputs by keyword or regex.
79. **Session Comparison Matrix**: View multiple projects running concurrently in a single unified dashboard view.
80. **One-Click Reproducible Issue Reporter**: Export a bug report with anonymized traces and system info for agent framework issues.

---

## Pillar 6: Universal Ecosystem Adapters & Protocols (Tasks 81–90)
81. **Official Model Context Protocol (MCP) Server**: Package AgentGDB as an MCP server with tools: `get_drift_status`, `request_approval`.
82. **Cursor IDE Extension / Companion Plugin**: Display AgentGDB drift alerts directly in the Cursor editor status bar.
83. **VS Code Extension**: Interactive panel inside VS Code showing the live timeline alongside code files.
84. **Claude Code Adapter**: Native watcher for Anthropic's `claude` CLI trajectory transcripts.
85. **OpenHands / SWE-Agent Ingestion Adapter**: Connect to Dockerized SWE-bench agent runs via volume mounts.
86. **Aider Chat Integration**: Live watcher for Aider git commits and conversation history logs.
87. **LangGraph & CrewAI State Exporter**: Python package (`agentgdb-python`) with callback handlers for LangGraph and CrewAI.
88. **AutoGPT / MetaGPT Socket Adapter**: Direct ingestion bridge for autonomous multi-agent frameworks.
89. **Ollama / vLLM Local Model Gateway**: Automatic prompt mapping and streaming for locally hosted SLMs.
90. **GitHub Actions CI Check Integration**: Run AgentGDB as a CI action to verify that AI PRs stayed within declared boundaries.

---

## Pillar 7: Security, Attestation & Enterprise Governance (Tasks 91–100)
91. **High-Entropy Secret Leak Interceptor**: Shannon entropy scanner combined with regexes to block zero-day API keys before disk write.
92. **SHA-256 Merkle-Linked Event Ledger**: Tamper-proof cryptographic block linking verifying that execution history was not modified.
93. **Digital Signature Keyring Integration**: Sign every approved agent commit using the developer's GPG/SSH key only after verification.
94. **Automated GitHub PR Markdown Summary Generator**: Synthesize verifiable "Agent Work Evidence" tables ready for PR descriptions.
95. **RBAC & Multi-User Permission Policies**: Enforce role boundaries (e.g. Jr Engineer agent cannot touch production deployment files).
96. **SOC-2 & ISO 27001 Audit Trail Exporter**: Export compliance reports proving human-in-the-loop verification on all AI commits.
97. **Air-Gapped Local-Only Mode**: Toggle network kill-switch ensuring zero packets leave localhost during agent runs.
98. **Homebrew Tap (`brew install agentgdb`)**: Publish an official formula on Homebrew for one-command macOS/Linux installation.
99. **Single-Binary Standalone Executable**: Compile into a zero-dependency native binary for distribution without requiring Node.js.
100. **Self-Hosted Team Sync Server**: Docker Compose deployment for multi-seat engineering teams sharing centralized trace logs.
