# Claude Code integration

1. Install `@codapult/guard` in the project and register its MCP server with the project's Claude
   Code configuration.
2. Add the generic Guard instruction from [generic.md](generic.md) to the project's Claude
   instructions file.
3. If hooks are enabled, use the host's post-task hook to call the Guard sequence and return the
   JSON result to the agent. Otherwise, keep the sequence in the project instructions.

The CLI does not invoke Claude or assume a particular model provider. It only returns structured
context and verification results.
