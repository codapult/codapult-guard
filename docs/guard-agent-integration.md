# Guard agent integration

Guard is the deterministic project gate and context provider. The host AI agent owns the repair
loop and must decide whether it is allowed to edit files.

Recommended host flow:

```text
task finished
  -> codapult_guard_context
  -> codapult_guard_review (requirement + diff)
  -> codapult_guard_verify
  -> if error and canRetry: edit, then repeat with iteration + 1
  -> report warnings and unresolved requirements
```

For a new project, use `codapult_guard_init` with `confirm: true`. Proposal persistence and
proposal activation also require explicit confirmation; stale proposals must be regenerated.
Every Guard MCP tool accepts an optional `root` when the MCP process is not started in the project
directory.

The equivalent CLI call is:

```bash
codapult-guard verify --json
```

Read `.codapult/guard/agent.json` before starting the loop. `completionGate.enabled` controls
whether the host enables the loop, `maxIterations` bounds repair attempts, `projectChecks` controls
lint/typecheck/test/build, and `tools` controls external adapters (`auto`, `on`, or `off`). Guard
does not invoke an LLM or modify source files itself.

Install the managed instruction block for a host when you want the workflow persisted in the
project:

```bash
codapult-guard install-agent cursor
codapult-guard install-agent all
```

The command updates only the block between `codapult-guard:start` and `codapult-guard:end` and
preserves unrelated instructions. Supported targets are `generic`, `codex`, `cursor`, `claude`,
`copilot`, and `gemini`.

For CI, run the same verification independently after the agent finishes. Do not treat an agent's
claim that it fixed a finding as a passing result; use the next Guard report as the source of truth.
