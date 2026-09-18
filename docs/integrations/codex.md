# Codex integration

1. Install `@codapult/guard` in the project and configure the Guard MCP server using the host's
   MCP configuration mechanism.
2. Add the generic Guard instruction from [generic.md](generic.md) to the project instructions
   used by Codex.
3. Let the host invoke `codapult_guard_context`, `codapult_guard_review`, and
   `codapult_guard_verify` after a task. Keep CI as the independent final gate.

Do not hard-code a provider API key in Guard. Codex supplies the model; Guard supplies project
evidence, contracts, proposals, and deterministic verification.
