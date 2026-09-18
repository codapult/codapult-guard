# Generic AI agent integration

Add the following to the agent's project instructions:

```text
After completing a coding task, call codapult_guard_context, then
codapult_guard_review with the requirement and changed diff, then
codapult_guard_verify. If the result contains an error, fix it and repeat
up to completionGate.maxIterations. Do not hide warnings or claim completion
without reporting unresolved requirements.
```

The CLI equivalent is:

```bash
codapult-guard review --requirement docs/acceptance.md
codapult-guard verify --json
```

Use the host's post-task hook to invoke the sequence. Run the same command independently in CI.
