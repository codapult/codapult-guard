import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildArchitectureMemory,
  buildConventionsMemory,
  discoverProject,
  findGuardRoot,
  GUARD_ARCHITECTURE_FILE,
  GUARD_CONVENTIONS_FILE,
  loadGuardAgentConfig,
  loadGuardArtifact,
  loadGuardConfig,
  loadGuardProposals,
} from '../core/guard.js';

function jsonResource(
  uri: string,
  value: unknown,
): { contents: { uri: string; text: string; mimeType: string }[] } {
  return {
    contents: [{ uri, text: JSON.stringify(value, null, 2), mimeType: 'application/json' }],
  };
}

export function registerGuardResources(server: McpServer): void {
  server.registerResource(
    'codapult_guard_rules',
    'codapult://guard/rules',
    {
      title: 'Architecture Guard Rules',
      description: 'Local architecture invariants available to CLI checks and AI agents',
      mimeType: 'application/json',
    },
    () => {
      const root = findGuardRoot();
      const config = loadGuardConfig(root);
      return jsonResource('codapult://guard/rules', {
        configured: config !== undefined,
        rules: config?.rules ?? [],
        contracts: config?.contracts ?? [],
        project: discoverProject(root),
      });
    },
  );

  server.registerResource(
    'codapult_guard_context',
    'codapult://guard/context',
    {
      title: 'Guard Project Context',
      description: 'Current project model, architecture policy, contracts, and gate settings.',
      mimeType: 'application/json',
    },
    () => {
      const root = findGuardRoot();
      const project = discoverProject(root);
      const config = loadGuardConfig(root);
      return jsonResource('codapult://guard/context', {
        version: 1,
        root,
        configured: config !== undefined,
        project,
        architecture:
          loadGuardArtifact(root, GUARD_ARCHITECTURE_FILE) ?? buildArchitectureMemory(project),
        conventions:
          loadGuardArtifact(root, GUARD_CONVENTIONS_FILE) ?? buildConventionsMemory(project),
        rules: config?.rules ?? [],
        contracts: config?.contracts ?? [],
        agent: loadGuardAgentConfig(root),
      });
    },
  );

  server.registerResource(
    'codapult_guard_architecture',
    'codapult://guard/architecture',
    {
      title: 'Guard Architecture Map',
      description: 'Observed architecture and conventions.',
      mimeType: 'application/json',
    },
    () => {
      const root = findGuardRoot();
      const project = discoverProject(root);
      return jsonResource('codapult://guard/architecture', {
        version: 1,
        root,
        architecture:
          loadGuardArtifact(root, GUARD_ARCHITECTURE_FILE) ?? buildArchitectureMemory(project),
        conventions:
          loadGuardArtifact(root, GUARD_CONVENTIONS_FILE) ?? buildConventionsMemory(project),
      });
    },
  );

  server.registerResource(
    'codapult_guard_proposals',
    'codapult://guard/proposals',
    {
      title: 'Architecture Guard Proposals',
      description: 'Evidence-backed rules and contracts awaiting review.',
      mimeType: 'application/json',
    },
    () => {
      const root = findGuardRoot();
      return jsonResource(
        'codapult://guard/proposals',
        loadGuardProposals(root) ?? { version: 1, rules: [], contracts: [], questions: [] },
      );
    },
  );
}
