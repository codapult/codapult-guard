import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerGuardPrompts(server: McpServer): void {
  server.registerPrompt(
    'codapult_guard_proposal_review',
    {
      title: 'Guard Proposal Review',
      description: 'Refine evidence-backed Guard rule and contract proposals before activation.',
      argsSchema: {
        proposals: z.string().describe('JSON proposal packet returned by codapult_guard_propose'),
        focus: z.string().optional().describe('Optional domain focus.'),
      },
    },
    ({ proposals, focus }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Review these Guard proposals against project evidence.${focus ? ` Focus on ${focus}.` : ''}

Keep only rules and contracts supported by repeated project evidence. For each proposal, return
keep/revise/reject, rationale, exact evidence, scope, severity, and unresolved questions. Never
activate a proposal automatically.

Proposal packet:\n\`\`\`json\n${proposals}\n\`\`\``,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'codapult_guard_semantic_review',
    {
      title: 'Guard Semantic Review',
      description:
        'Review a Guard packet against project-specific contracts and architecture context.',
      argsSchema: {
        packet: z.string().describe('JSON review packet returned by codapult_guard_review'),
        focus: z
          .string()
          .optional()
          .describe('Optional focus such as auth, data access, or API behavior.'),
      },
    },
    ({ packet, focus }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Perform an evidence-based semantic architecture review.${focus ? ` Focus on: ${focus}.` : ''}

Treat contracts as project-specific invariants. Do not repeat deterministic findings. Separate
violations from recommendations and include severity, file, evidence, explanation, and remediation.
If evidence is insufficient, say so instead of guessing. Do not infer redacted secrets.

Guard packet:\n\`\`\`json\n${packet}\n\`\`\``,
          },
        },
      ],
    }),
  );
}
