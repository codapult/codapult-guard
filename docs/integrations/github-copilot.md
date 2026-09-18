# GitHub Copilot integration

1. Install `@codapult/guard` in the project and register the Guard MCP server in the Copilot
   client or workspace configuration that supports MCP.
2. Put the instruction from [generic.md](generic.md) in the repository's Copilot instructions
   file, such as `.github/copilot-instructions.md`.
3. Ask the agent to run the Guard context/review/verify sequence at task completion. Keep CI as
   the independent final gate because the editor agent may not run after a session ends.

Guard does not depend on Copilot APIs. The integration is the repository instruction plus the
standard MCP surface.
