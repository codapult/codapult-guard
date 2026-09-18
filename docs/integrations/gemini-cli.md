# Gemini CLI integration

1. Install `@codapult/guard` in the project and register the Guard MCP server using the Gemini
   CLI MCP configuration supported by the installed version.
2. Add the instruction from [generic.md](generic.md) to the repository instruction file used by
   the CLI.
3. At the end of a task, invoke Guard context, semantic review, and verification. Run the same
   verification command in CI so the result does not depend on the local model session.

The kit intentionally avoids version-specific hook syntax. Gemini CLI supplies the model and
host lifecycle; Guard supplies project evidence, contracts, proposals, and deterministic gates.
