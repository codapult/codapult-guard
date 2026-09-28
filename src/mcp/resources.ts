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
  loadGuardWaivers,
  GuardStateBusyError,
  GuardStateStaleError,
} from '../core/guard.js';
import { guardErrorPayload } from '../core/errors.js';
import { DiscoveryStaleError } from '../core/discovery/discovery.js';
import { listGuardRuns, summarizeGuardRuns } from '../core/history/runs.js';

interface JsonResource {
  [key: string]: unknown;
  contents: { uri: string; text: string; mimeType: string }[];
}

function jsonResource(uri: string, value: unknown): JsonResource {
  return {
    contents: [{ uri, text: JSON.stringify(value, null, 2), mimeType: 'application/json' }],
  };
}

function resourceError(uri: string, error: unknown): ReturnType<typeof jsonResource> {
  const errorCode =
    error instanceof GuardStateBusyError
      ? 'GUARD_STATE_BUSY'
      : error instanceof GuardStateStaleError || error instanceof DiscoveryStaleError
        ? 'GUARD_STATE_STALE'
        : 'GUARD_CONFIG_INVALID';
  return jsonResource(
    uri,
    guardErrorPayload(errorCode, error instanceof Error ? error.message : String(error), {
      configured: errorCode !== 'GUARD_CONFIG_INVALID',
      outcome: 'error',
      recoverable: true,
      hint: 'Repair the invalid Guard artifact, then run codapult-guard doctor.',
    }),
  );
}

export function registerGuardResources(server: McpServer): void {
  server.registerResource(
    'codapult_guard_runs',
    'codapult://guard/runs',
    {
      title: 'Guard Run History',
      description: 'Local verification outcomes, gates, and stage timings.',
      mimeType: 'application/json',
    },
    () => {
      const root = findGuardRoot();
      return jsonResource('codapult://guard/runs', {
        version: 1,
        root,
        summary: summarizeGuardRuns(root),
        runs: listGuardRuns(root),
      });
    },
  );

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
      try {
        const config = loadGuardConfig(root);
        return jsonResource('codapult://guard/rules', {
          configured: config !== undefined,
          rules: config?.rules ?? [],
          contracts: config?.contracts ?? [],
          project: discoverProject(root),
        });
      } catch (error) {
        return resourceError('codapult://guard/rules', error);
      }
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
      try {
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
      } catch (error) {
        return resourceError('codapult://guard/context', error);
      }
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
      try {
        const project = discoverProject(root);
        return jsonResource('codapult://guard/architecture', {
          version: 1,
          root,
          architecture:
            loadGuardArtifact(root, GUARD_ARCHITECTURE_FILE) ?? buildArchitectureMemory(project),
          conventions:
            loadGuardArtifact(root, GUARD_CONVENTIONS_FILE) ?? buildConventionsMemory(project),
        });
      } catch (error) {
        return resourceError('codapult://guard/architecture', error);
      }
    },
  );

  server.registerResource(
    'codapult_guard_waivers',
    'codapult://guard/waivers',
    {
      title: 'Guard Waivers',
      description: 'Active and expired time-bounded exceptions to Guard findings.',
      mimeType: 'application/json',
    },
    () => {
      const root = findGuardRoot();
      try {
        return jsonResource('codapult://guard/waivers', {
          version: 1,
          root,
          waivers: loadGuardWaivers(root),
        });
      } catch (error) {
        return resourceError('codapult://guard/waivers', error);
      }
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
      try {
        return jsonResource(
          'codapult://guard/proposals',
          loadGuardProposals(root) ?? { version: 1, rules: [], contracts: [], questions: [] },
        );
      } catch (error) {
        return resourceError('codapult://guard/proposals', error);
      }
    },
  );
}
