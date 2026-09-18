import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GUARD_HISTORY_DIR } from '../guard.js';
import type { ProjectModel } from '../discovery/discovery.js';

export interface GuardSnapshotSummary {
  revision: string;
  path: string;
  files: number;
  modules: number;
  capabilities: string[];
  cycles: number;
}

export interface GuardHistoryDiff {
  from: string;
  to: string;
  addedFiles: string[];
  removedFiles: string[];
  addedDependencies: string[];
  removedDependencies: string[];
  addedCapabilities: string[];
  removedCapabilities: string[];
  addedModules: string[];
  removedModules: string[];
  addedDependencyEdges: string[];
  removedDependencyEdges: string[];
  addedLayerEdges: string[];
  removedLayerEdges: string[];
  cycles: { from: number; to: number };
}

type SnapshotInsights = Partial<ProjectModel['insights']>;

function snapshotInsights(model: ProjectModel): SnapshotInsights {
  return (model as unknown as { insights?: SnapshotInsights }).insights ?? {};
}

function dependencyEdges(model: ProjectModel): string[] {
  return (snapshotInsights(model).dependencyEdges ?? [])
    .map((edge) => `${edge.from} -> ${edge.to}`)
    .sort();
}

function layerEdges(model: ProjectModel): string[] {
  return (snapshotInsights(model).layerEdges ?? [])
    .map((edge) => `${edge.from} -> ${edge.to}`)
    .sort();
}

function readSnapshot(root: string, revision: string): ProjectModel | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(revision)) return undefined;
  try {
    return JSON.parse(
      readFileSync(resolve(root, GUARD_HISTORY_DIR, `${revision}.json`), 'utf8'),
    ) as ProjectModel;
  } catch {
    return undefined;
  }
}

export function listGuardSnapshots(root: string): GuardSnapshotSummary[] {
  const directory = resolve(root, GUARD_HISTORY_DIR);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .flatMap((file) => {
      const revision = file.slice(0, -5);
      const model = readSnapshot(root, revision);
      return model
        ? [
            {
              revision,
              path: `${GUARD_HISTORY_DIR}/${file}`,
              files: model.files.length,
              modules: model.modules.length,
              capabilities: Object.keys(model.capabilities).sort(),
              cycles: snapshotInsights(model).cycles?.length ?? 0,
            },
          ]
        : [];
    });
}

export function diffGuardSnapshots(
  root: string,
  from: string,
  to: string,
): GuardHistoryDiff | undefined {
  const before = readSnapshot(root, from);
  const after = readSnapshot(root, to);
  if (!before || !after) return undefined;
  const difference = (left: string[], right: string[]): string[] =>
    right.filter((value) => !left.includes(value)).sort();
  const beforeFiles = before.files.map((file) => file.path);
  const afterFiles = after.files.map((file) => file.path);
  const beforeDependencies = Object.keys({
    ...before.project.dependencies,
    ...before.project.devDependencies,
  });
  const afterDependencies = Object.keys({
    ...after.project.dependencies,
    ...after.project.devDependencies,
  });
  const beforeModules = before.modules.map((module) => module.path);
  const afterModules = after.modules.map((module) => module.path);
  return {
    from,
    to,
    addedFiles: difference(beforeFiles, afterFiles),
    removedFiles: difference(afterFiles, beforeFiles),
    addedDependencies: difference(beforeDependencies, afterDependencies),
    removedDependencies: difference(afterDependencies, beforeDependencies),
    addedCapabilities: difference(
      Object.keys(before.capabilities),
      Object.keys(after.capabilities),
    ),
    removedCapabilities: difference(
      Object.keys(after.capabilities),
      Object.keys(before.capabilities),
    ),
    addedModules: difference(beforeModules, afterModules),
    removedModules: difference(afterModules, beforeModules),
    addedDependencyEdges: difference(dependencyEdges(before), dependencyEdges(after)),
    removedDependencyEdges: difference(dependencyEdges(after), dependencyEdges(before)),
    addedLayerEdges: difference(layerEdges(before), layerEdges(after)),
    removedLayerEdges: difference(layerEdges(after), layerEdges(before)),
    cycles: {
      from: snapshotInsights(before).cycles?.length ?? 0,
      to: snapshotInsights(after).cycles?.length ?? 0,
    },
  };
}
