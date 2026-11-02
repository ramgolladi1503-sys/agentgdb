# AgentGDB developer pilot: facilitator and response form

**Status:** Instrument only. No participants have completed this form. Do not cite it as survey evidence.

## Purpose

Evaluate whether a coding-agent user can install and start AgentGDB, connect one supported agent through the managed MCP tools, understand an approval request, inspect an observed transcript, recover from a routine setup error, and find the data-retention/deletion controls. This is a formative usability study, not a security certification or market-size survey.

Run an observed pilot with 8–12 developers who used a coding agent in the previous month. Use a disposable repository with no credentials or personal data. Test the exact candidate SHA and record OS, version, AgentGDB commit, agent host/version, and enabled host tools. Do not allow native file or shell tools during mediated-action tasks.

Do not fabricate responses, quotes, participants, or scores. Keep participant contact details separate from response records. Obtain consent before recording notes or screen activity. Participants may skip a question or stop at any time. Do not collect source code, API keys, tokens, or raw transcripts.

## Participant information and consent

Study code: `__________`  Date: `__________`  Candidate SHA: `________________________________________`

OS/version: `________________________`  Agent host/version: `________________________`

Experience using coding agents: `________ years/months`

Frequency of use: `☐ Daily  ☐ Several times/week  ☐ Weekly  ☐ Less often`

Consent statement: “I understand that this session evaluates the AgentGDB prototype. The facilitator may record task completion, time, errors, and my answers below. I will use only the provided disposable workspace. I will not enter secrets or personal data. My participation is voluntary; I can skip questions or stop without giving a reason. Findings will be reported without my name.”

Consent: `☐ Yes  ☐ No (stop session)`  Recording consent, if applicable: `☐ Yes  ☐ No`

## Facilitator protocol

1. Start from a clean user profile or documented clean install. Do not coach unless the participant is blocked for two minutes; record any help given.
2. Give the participant the task prompts below verbatim. Do not explain expected controls in advance.
3. Use a disposable project and fixture transcript supplied for the study. Keep the managed MCP adapter as the only available filesystem/command tool during mediation tasks.
4. Observe without asking the participant to expose secrets, personal files, or private transcripts. Stop immediately if the participant points AgentGDB at non-disposable data.
5. Record completion, elapsed time, errors, help, and participant comments. Distinguish observed behavior from the participant's opinion.
6. At the end, confirm the participant can identify what was stored and perform deletion. Remove study workspace data according to the study protocol.

## Task prompts and observation record

Use one row per task. Completion means the participant reached the stated outcome without facilitator action. Record actual time; do not infer it.

| Task | Prompt to participant | Completed? | Time | Errors / help | Notes (observed facts only) |
|---|---|---|---:|---|---|
| 1. First run | “Start AgentGDB and show me how you would try it without connecting an account or API key.” | ☐ Yes ☐ No | | | |
| 2. Workspace setup | “Register the disposable project. Allow only its `src/` directory. Tell me what that permission means.” | ☐ Yes ☐ No | | | |
| 3. Transcript setup | “Attach the provided JSONL transcript. Find the latest recorded step and tell me whether this is live enforcement or observation.” | ☐ Yes ☐ No | | | |
| 4. Read action | “Using the configured AgentGDB tools, inspect the provided source fixture.” | ☐ Yes ☐ No | | | |
| 5. Approval | “Request the provided disposable file change. Before deciding, explain what the approval screen says will happen and what risk it presents.” | ☐ Yes ☐ No | | | |
| 6. Denial | “Request the supplied out-of-scope path or non-allowlisted command. Tell me what happened.” | ☐ Yes ☐ No | | | |
| 7. Recovery | “The transcript path is now unavailable. Recover and explain the displayed error.” | ☐ Yes ☐ No | | | |
| 8. Privacy | “Show me whether payload capture is enabled, where local data is kept, how retention works, and how you would delete old traces.” | ☐ Yes ☐ No | | | |

Facilitator intervention details (task number, what was said/done, and why):

`______________________________________________________________________________`

`______________________________________________________________________________`

## Participant ratings

For each statement, circle one response. Use `N/A` if the participant did not attempt the workflow.

Scale: `1 Strongly disagree · 2 Disagree · 3 Neither · 4 Agree · 5 Strongly agree · N/A`

| Statement | 1 | 2 | 3 | 4 | 5 | N/A |
|---|---:|---:|---:|---:|---:|---:|
| I could tell what to do on first run. | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| Workspace and transcript setup errors explained how to recover. | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| The path allowlist was understandable and specific enough to configure. | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| The approval request showed the exact action I was deciding about. | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| I understood that denial or timeout prevents the managed action from proceeding. | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| I understood that native/alternate agent tools can bypass this adapter. | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| I understood what transcript and trace data AgentGDB stores. | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| I could find and use the deletion controls. | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| I would use this workflow for a low-risk coding task after the stated limitations were addressed. | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |

## Open questions

1. What was the first point where you were unsure what to do?

   `___________________________________________________________________________`

2. What did you believe AgentGDB could prevent? What evidence led you to that belief?

   `___________________________________________________________________________`

3. Was any approval detail missing or hard to compare with the proposed action?

   `___________________________________________________________________________`

4. What data would you avoid putting through this prototype, and why?

   `___________________________________________________________________________`

5. What one change would most improve this workflow?

   `___________________________________________________________________________`

6. What, if anything, would prevent you from trying it again?

   `___________________________________________________________________________`

## Per-session summary

First task completed without help: `__________`  All tasks completed: `________ / 8`

Total facilitator interventions: `__________`  Participant stopped early: `☐ Yes ☐ No`

Most severe observed usability issue: `☐ P0 safety misunderstanding ☐ P1 blocked task ☐ P2 workaround ☐ P3 cosmetic ☐ None`

Issue description and evidence (avoid personal data):

`______________________________________________________________________________`

Participant's own recommendation (quote only with consent; otherwise paraphrase):

`______________________________________________________________________________`

## Analysis and reporting rules

- Report participant count, recruitment criteria, OS/agent versions, candidate SHA, and facilitator interventions.
- Report task success as `completed / attempted`, and report medians with ranges for times. Include skipped tasks and early stops; do not silently exclude failures.
- Present rating distributions by item. With 8–12 participants, call these formative observations; do not imply statistical representativeness or a developer-wide opinion.
- Separate direct observations, participant statements, and facilitator interpretation. Use anonymized study codes and paraphrase unless quoting consent was recorded.
- Fix safety misunderstandings and repeated task blockers before widening recruitment. Preserve negative findings.
- A larger survey, including a 1,000-person survey, requires a defined target population, recruitment and consent plan, a piloted instrument, response-quality controls, and transparent sampling limitations. Never generate synthetic responses and label them as developer opinions.
- This form alone does not satisfy the release gate. The release gate requires an observed pilot of at least eight participants with evidence bound to the exact release commit, plus separate platform CI, real-agent, and independent security-review evidence.

## Session record template

Create one copy per participant, store it in access-controlled study storage, and retain it only for the period stated in the approved study protocol. Keep the aggregate report separate from identifying/contact information.
