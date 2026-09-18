# Cursor integration

1. Install `@codapult/guard` in the project and register the Guard MCP server in the project's
   Cursor MCP configuration.
2. Copy the generic instruction from [generic.md](generic.md) into a project rule under the
   project's Cursor rules directory.
3. Configure the host's task/completion workflow to call the three Guard MCP tools. If the host
   does not expose a post-task hook, the same sequence can be requested through the project rule.

Guard's `agent.json` remains the source of truth for `maxIterations`, project checks, and tool mode.
