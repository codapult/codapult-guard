import { describe, expect, it } from 'vitest';
import { analyzeProjectImpact } from './impact.js';
import type { ProjectModel } from '../discovery/discovery.js';

function model(): ProjectModel {
  return {
    version: 1,
    project: {
      frameworks: [],
      scripts: {},
      dependencies: {},
      devDependencies: {},
      workspacePackages: [],
    },
    files: [],
    modules: [
      {
        path: 'route.ts',
        contentHash: 'route',
        imports: ['./service'],
        importedSymbols: [],
        exports: [],
        calls: [],
        resolvedImports: ['service.ts'],
        dynamicImports: [],
        declarations: { classes: 0, functions: 0, interfaces: 0, types: 0, variables: 0 },
        directives: [],
      },
      {
        path: 'service.ts',
        contentHash: 'service',
        imports: ['./repository'],
        importedSymbols: [],
        exports: [],
        calls: [],
        resolvedImports: ['repository.ts'],
        dynamicImports: [],
        declarations: { classes: 0, functions: 0, interfaces: 0, types: 0, variables: 0 },
        directives: [],
      },
      {
        path: 'repository.ts',
        contentHash: 'repository',
        imports: [],
        importedSymbols: [],
        exports: [],
        calls: [],
        resolvedImports: [],
        dynamicImports: [],
        declarations: { classes: 0, functions: 0, interfaces: 0, types: 0, variables: 0 },
        directives: [],
      },
      {
        path: 'unrelated.ts',
        contentHash: 'unrelated',
        imports: [],
        importedSymbols: [],
        exports: [],
        calls: [],
        resolvedImports: [],
        dynamicImports: [],
        declarations: { classes: 0, functions: 0, interfaces: 0, types: 0, variables: 0 },
        directives: [],
      },
    ],
    configs: [],
    schemas: [],
    tests: { files: [], scripts: {} },
    git: {
      repository: false,
      dirty: false,
      changedFiles: [],
      status: [],
      diffStat: '',
      history: [],
    },
    patterns: {
      clientComponents: [],
      serverActions: [],
      routeHandlers: ['route.ts'],
      routeDetails: [],
      barrelFiles: [],
      importGraphEdges: 3,
    },
    capabilities: {
      persistence: {
        status: 'observed',
        confidence: 'high',
        packages: [],
        files: ['repository.ts'],
        imports: [],
        evidence: [],
      },
    },
    insights: {
      layers: {
        routes: ['route.ts'],
        application: ['service.ts'],
        infrastructure: ['repository.ts'],
        other: ['unrelated.ts'],
      },
      cycles: [],
      importHotspots: [],
      boundaries: [],
      layerEdges: [
        { from: 'routes', to: 'application', count: 1 },
        { from: 'application', to: 'infrastructure', count: 1 },
      ],
      dependencyEdges: [
        { from: 'route.ts', to: 'service.ts' },
        { from: 'service.ts', to: 'repository.ts' },
      ],
      envReferences: [],
      impactPaths: [
        {
          entrypoint: 'route.ts',
          files: ['route.ts', 'service.ts', 'repository.ts'],
          layers: ['routes', 'application', 'infrastructure'],
          boundaries: [],
        },
      ],
    },
  };
}

describe('analyzeProjectImpact', () => {
  it('returns transitive dependencies, dependents, capabilities, and scoped contracts', () => {
    const result = analyzeProjectImpact(
      model(),
      ['repository.ts'],
      [
        { id: 'repo-contract', statement: 'repository boundary', scope: ['repository.ts'] },
        { id: 'route-contract', statement: 'route boundary', entrypoints: ['route.ts'] },
        { id: 'unrelated-contract', statement: 'unrelated', scope: ['unrelated.ts'] },
      ],
    );

    expect(result.dependencies).toEqual([]);
    expect(result.dependents).toEqual(['route.ts', 'service.ts']);
    expect(result.affectedModules).toEqual(['repository.ts', 'route.ts', 'service.ts']);
    expect(result.capabilities).toEqual(['persistence']);
    expect(result.relevantContracts.map((contract) => contract.id)).toEqual([
      'repo-contract',
      'route-contract',
    ]);
    expect(result.impactPaths).toHaveLength(1);
  });
});
