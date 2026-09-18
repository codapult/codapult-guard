import type { GuardContract } from '../guard.js';
import { buildModuleTargetGraph, type ProjectModel } from '../discovery/discovery.js';

export interface GuardImpactAnalysis {
  requestedFiles: string[];
  directModules: string[];
  dependencies: string[];
  dependents: string[];
  affectedModules: string[];
  impactPaths: ProjectModel['insights']['impactPaths'];
  capabilities: string[];
  relevantContracts: GuardContract[];
  dependencyEdges: ProjectModel['insights']['dependencyEdges'];
  layerEdges: ProjectModel['insights']['layerEdges'];
}

function matchesScope(path: string, scope: string): boolean {
  return path === scope || path.startsWith(`${scope.replace(/\\/g, '/')}/`);
}

function walk(graph: Map<string, string[]>, starts: Iterable<string>): Set<string> {
  const visited = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const next of graph.get(current) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return visited;
}

/**
 * Computes the blast radius of a change from the discovered graph.
 *
 * The graph direction is importer -> imported module. Therefore `dependencies` are what the
 * changed code relies on, while `dependents` are callers that can regress when the changed
 * code changes. Both directions matter for an AI review packet.
 */
export function analyzeProjectImpact(
  model: ProjectModel,
  files: Iterable<string>,
  contracts: GuardContract[] = [],
): GuardImpactAnalysis {
  const requestedFiles = [...new Set([...files].map((file) => file.replace(/\\/g, '/')))].sort();
  const modulePaths = new Set(model.modules.map((module) => module.path));
  const directModules = requestedFiles.filter((file) => modulePaths.has(file));
  const graph = buildModuleTargetGraph(model.modules);
  const reverse = new Map<string, string[]>();
  for (const [from, targets] of graph) {
    for (const to of targets) {
      const callers = reverse.get(to) ?? [];
      callers.push(from);
      reverse.set(to, callers);
    }
  }
  const dependencies = walk(graph, directModules);
  const dependencyList = [...dependencies].filter((path) => !directModules.includes(path)).sort();
  const dependents = walk(reverse, directModules);
  const dependentList = [...dependents].filter((path) => !directModules.includes(path)).sort();
  const affected = new Set([...directModules, ...dependencyList, ...dependentList]);
  const impactPaths = model.insights.impactPaths.filter(
    (impact) =>
      impact.entrypoint &&
      (affected.has(impact.entrypoint) || impact.files.some((file) => affected.has(file))),
  );
  const capabilities = Object.entries(model.capabilities)
    .filter(([, signal]) => signal.files.some((file) => affected.has(file)))
    .map(([id]) => id)
    .sort();
  const relevantContracts = contracts.filter((contract) => {
    const scopes = [...(contract.scope ?? []), ...(contract.entrypoints ?? [])];
    return (
      scopes.length === 0 ||
      scopes.some((scope) => [...affected].some((file) => matchesScope(file, scope)))
    );
  });
  const dependencyEdges = model.insights.dependencyEdges.filter(
    (edge) => affected.has(edge.from) || affected.has(edge.to),
  );
  const affectedLayers = new Set(
    Object.entries(model.insights.layers)
      .filter(([, paths]) => paths.some((path) => affected.has(path)))
      .map(([layer]) => layer),
  );
  const layerEdges = model.insights.layerEdges.filter(
    (edge) => affectedLayers.has(edge.from) || affectedLayers.has(edge.to),
  );
  return {
    requestedFiles,
    directModules,
    dependencies: dependencyList,
    dependents: dependentList,
    affectedModules: [...affected].sort(),
    impactPaths,
    capabilities,
    relevantContracts,
    dependencyEdges,
    layerEdges,
  };
}
