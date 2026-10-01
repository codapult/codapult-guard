# Generic AI agent integration

Install Guard and initialize the project before adding an agent instruction:

```bash
pnpm add -D @codapult/guard
pnpm exec codapult-guard init
```

Guard is discoverable in the [official MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.codapult%2Fguard)
as `io.github.codapult/guard`. If the host does not import Registry entries, register the local
stdio command `pnpm exec codapult-guard mcp-server` in its MCP configuration.

Add the following to the agent's project instructions:

```text
After completing a coding task, call codapult_guard_next_action and follow its bounded next step.
Normally call codapult_guard_context, then codapult_guard_review with the requirement and changed
diff, then codapult_guard_verify. If the result contains an error, fix it and repeat up to
completionGate.maxIterations. Do not hide warnings or claim completion without reporting
unresolved requirements.
```

The CLI equivalent is:

```bash
codapult-guard review --requirement docs/acceptance.md
codapult-guard verify --json
```

Use the host's post-task hook to invoke the sequence. Run the same command independently in CI.
