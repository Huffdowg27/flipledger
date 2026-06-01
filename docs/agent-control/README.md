# Agent Control

This folder is the handoff surface between the human, Codex, and Claude Code.
Use it to avoid long copy/paste prompts and to keep a reviewable paper trail.

## Workflow

1. Codex writes or updates `NEXT_CLAUDE_TASK.md`.
2. Claude reads `NEXT_CLAUDE_TASK.md` and `PRODUCT_GUARDRAILS.md`.
3. Claude performs only that task.
4. Claude updates `CLAUDE_REPORT.md`.
5. Codex reviews `git status`, `git diff`, verification output, and the report.

## Standing Claude Instruction

Before doing work:

```text
Read docs/agent-control/NEXT_CLAUDE_TASK.md and docs/agent-control/PRODUCT_GUARDRAILS.md.
Do only the requested task.
Afterward, update docs/agent-control/CLAUDE_REPORT.md.
```

If a task would touch restricted areas, stop and ask.
