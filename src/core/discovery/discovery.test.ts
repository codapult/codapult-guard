import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverProject, discoverProjectWithMetrics } from './discovery.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('discoverProject', () => {
  it('builds a universal model from package metadata, source AST, tests, and patterns', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-discovery-'));
    roots.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'example',
        packageManager: 'pnpm@11',
        scripts: { test: 'vitest', lint: 'eslint .' },
        dependencies: {
          next: 'latest',
          react: 'latest',
          vite: 'latest',
          stripe: 'latest',
          bullmq: 'latest',
          resend: 'latest',
        },
      }),
    );
    writeFileSync(
      join(root, 'page.tsx'),
      `'use client';\nimport React from 'react';\nexport function Page() { return null; }\n`,
    );
    writeFileSync(
      join(root, 'page.test.ts'),
      `import { test } from 'vitest';\ntest('page', () => {});\n`,
    );
    writeFileSync(join(root, 'schema.ts'), `export type User = { id: string };\n`);
    writeFileSync(join(root, 'env.ts'), `export const url = process.env.DATABASE_URL;\n`);
    writeFileSync(join(root, '.env.example'), 'DATABASE_URL=\n');
    writeFileSync(join(root, 'next.config.mjs'), `export default {};\n`);
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(
      join(root, 'app/route.ts'),
      `export async function GET() { return new Response('ok'); }\nexport const POST = async () => new Response('ok');\n`,
    );
    mkdirSync(join(root, 'content'), { recursive: true });
    writeFileSync(join(root, 'content/configuration.mdx'), '# Configuration\n');
    writeFileSync(join(root, '.env.local'), 'SECRET=value\n');
    writeFileSync(join(root, 'local.db'), 'database\n');
    writeFileSync(join(root, 'tsconfig.tsbuildinfo'), '{}\n');
    writeFileSync(join(root, 'a.ts'), `import { b } from './b'; export const a = b;\n`);
    writeFileSync(join(root, 'b.ts'), `import { a } from './a'; export const b = a;\n`);
    writeFileSync(
      join(root, 'dynamic.ts'),
      `export const lazy = () => import('./b');\nexport const required = require('./a');\n`,
    );

    const model = discoverProject(root);

    expect(model.project.name).toBe('example');
    expect(model.project.frameworks).toEqual(['Next.js', 'React']);
    expect(model.project.workspacePackages).toEqual([]);
    expect(model.tests.files).toEqual(['page.test.ts']);
    expect(model.configs).toContain('next.config.mjs');
    expect(model.configs).not.toContain('content/configuration.mdx');
    expect(model.schemas).toEqual(['schema.ts']);
    expect(model.insights.envReferences).toEqual([
      { name: 'DATABASE_URL', files: ['env.ts'], declared: true },
    ]);
    expect(model.files.map((file) => file.path)).not.toEqual(
      expect.arrayContaining(['.env.local', 'local.db', 'tsconfig.tsbuildinfo']),
    );
    expect(model.patterns.clientComponents).toEqual(['page.tsx']);
    expect(model.patterns.routeHandlers).toEqual(['app/route.ts']);
    expect(model.patterns.routeDetails).toEqual([
      { path: 'app/route.ts', methods: ['GET', 'POST'] },
    ]);
    const routeImpact = model.insights.impactPaths.find(
      (impact) => impact.entrypoint === 'app/route.ts',
    );
    expect(routeImpact?.files).toContain('app/route.ts');
    expect(routeImpact?.layers).toContain('routes');
    expect(model.capabilities.payments.packages).toEqual(['stripe']);
    expect(model.capabilities.payments.status).toBe('inferred');
    expect(model.capabilities.jobs.packages).toEqual(['bullmq']);
    expect(model.capabilities.email.packages).toEqual(['resend']);
    expect(model.patterns.importGraphEdges).toBeGreaterThan(0);
    expect(model.insights.cycles).toEqual([['a.ts', 'b.ts']]);
    expect(model.git.history).toEqual([]);
    expect(
      model.insights.dependencyEdges.some((edge) => edge.from === 'a.ts' && edge.to === 'b.ts'),
    ).toBe(true);
    expect(
      model.insights.dependencyEdges.some((edge) => edge.from === 'b.ts' && edge.to === 'a.ts'),
    ).toBe(true);
    expect(model.insights.layers.other).toContain('a.ts');
    expect(model.modules.find((module) => module.path === 'dynamic.ts')).toMatchObject({
      dynamicImports: ['./a', './b'],
    });
    expect(model.insights.importHotspots[0]).toMatchObject({ module: 'react', count: 1 });
    expect(model.modules.find((module) => module.path === 'page.tsx')).toMatchObject({
      imports: ['react'],
      declarations: { functions: 1 },
      directives: ['use client'],
    });
  });

  it('records nested workspace package boundaries and their scripts', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-workspace-'));
    roots.push(root);
    mkdirSync(join(root, 'apps/web'), { recursive: true });
    mkdirSync(join(root, 'packages/core'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }),
    );
    writeFileSync(
      join(root, 'apps/web/package.json'),
      JSON.stringify({
        name: '@example/web',
        scripts: { build: 'vite' },
        dependencies: { react: '^1' },
      }),
    );
    writeFileSync(
      join(root, 'packages/core/package.json'),
      JSON.stringify({ name: '@example/core', private: true, dependencies: { zod: '^1' } }),
    );

    const model = discoverProject(root);

    expect(model.project.workspacePackages).toEqual([
      expect.objectContaining({ path: 'apps/web', name: '@example/web', private: false }),
      expect.objectContaining({ path: 'packages/core', name: '@example/core', private: true }),
    ]);
  });

  it('resolves tsconfig aliases, re-exports, imported symbols, and calls through ts-morph', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-tsconfig-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'aliases', scripts: {} }));
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          baseUrl: '.',
          paths: { '@/*': ['src/*'] },
        },
        include: ['src/**/*.ts'],
      }),
    );
    writeFileSync(join(root, 'src/a.ts'), `export function loadUser() { return null; }\n`);
    writeFileSync(
      join(root, 'src/b.ts'),
      `import { loadUser as getUser } from '@/a'; export const user = getUser();\n`,
    );
    writeFileSync(join(root, 'src/index.ts'), `export { loadUser } from '@/a';\n`);

    const model = discoverProject(root);
    const module = model.modules.find((item) => item.path === 'src/b.ts');

    expect(module?.resolvedImports).toEqual(['src/a.ts']);
    expect(module?.importedSymbols).toEqual(['getUser']);
    expect(module?.calls).toContain('getUser');
    expect(model.insights.dependencyEdges).toContainEqual({ from: 'src/b.ts', to: 'src/a.ts' });
  });

  it('keeps AST-resolved and fallback edges when a module mixes aliases and relative imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-mixed-graph-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mixed-graph' }));
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
        include: ['src/**/*.ts'],
      }),
    );
    writeFileSync(join(root, 'src/alias.ts'), 'export const alias = true;\n');
    writeFileSync(join(root, 'src/relative.ts'), 'export const relative = true;\n');
    writeFileSync(
      join(root, 'src/entry.ts'),
      `import { alias } from '@/alias';\nimport { relative } from './relative';\nexport { alias, relative };\n`,
    );

    const model = discoverProject(root);
    expect(model.insights.dependencyEdges).toEqual(
      expect.arrayContaining([
        { from: 'src/entry.ts', to: 'src/alias.ts' },
        { from: 'src/entry.ts', to: 'src/relative.ts' },
      ]),
    );
  });

  it('uses AST for route exports and environment references, ignoring comments and strings', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-adversarial-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'adversarial' }));
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(
      join(root, 'app/route.ts'),
      `// export function DELETE() {}
const handler = async () => new Response('ok');
export { handler as POST };
const text = "export function PUT() {}";
`,
    );
    writeFileSync(
      join(root, 'env.ts'),
      `const ignored = 'process.env.NOT_A_REFERENCE';
export const url = process.env.DATABASE_URL;
export const key = process.env['API_KEY'];
`,
    );

    const model = discoverProject(root);

    expect(model.patterns.routeDetails).toEqual([{ path: 'app/route.ts', methods: ['POST'] }]);
    expect(model.insights.envReferences).toEqual([
      { name: 'API_KEY', files: ['env.ts'], declared: false },
      { name: 'DATABASE_URL', files: ['env.ts'], declared: false },
    ]);
  });

  it('does not follow symlinks and reports deleted and renamed Git paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-git-adversarial-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'git-fixture' }));
    writeFileSync(join(root, 'original.ts'), 'export const value = 1;\n');
    mkdirSync(join(root, 'outside'), { recursive: true });
    writeFileSync(join(root, 'outside/secret.ts'), 'export const secret = true;\n');
    symlinkSync(join(root, 'outside'), join(root, 'linked-outside'));

    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'guard@example.test']);
    git(['config', 'user.name', 'Guard Test']);
    git(['add', '.']);
    git(['commit', '-qm', 'initial']);
    git(['mv', 'original.ts', 'renamed.ts']);
    rmSync(join(root, 'outside/secret.ts'));

    const model = discoverProject(root);

    expect(model.files.map((file) => file.path)).not.toContain('linked-outside/secret.ts');
    expect(model.git.changedFiles).toEqual(
      expect.arrayContaining(['renamed.ts', 'outside/secret.ts']),
    );
  });

  it('keeps external declaration files out of the internal dependency graph', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-external-'));
    roots.push(root);
    mkdirSync(join(root, 'node_modules/external'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'external', scripts: {} }));
    writeFileSync(
      join(root, 'node_modules/external/index.d.ts'),
      'export declare const x: string;',
    );
    writeFileSync(join(root, 'index.ts'), `import { x } from 'external'; export { x };\n`);

    const model = discoverProject(root);

    expect(model.insights.dependencyEdges.every((edge) => !edge.to.includes('node_modules'))).toBe(
      true,
    );
  });

  it('persists a cache only for initialized projects and invalidates it after edits', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-cache-'));
    roots.push(root);
    mkdirSync(join(root, '.codapult/guard'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'cache', scripts: {} }));
    writeFileSync(join(root, 'index.ts'), 'export const value = 1;\n');

    const first = discoverProject(root);
    expect(existsSync(join(root, '.codapult/guard/cache.json'))).toBe(true);
    const second = discoverProject(root);
    expect(second).toBe(first);
    writeFileSync(join(root, 'index.ts'), 'export const value = 200;\n');

    expect(discoverProject(root)).not.toBe(first);

    const cachePath = join(root, '.codapult/guard/cache.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(cachePath, JSON.stringify({ ...cache, version: 1 }));
    writeFileSync(join(root, 'package.json'), '{\n  "name": "cache",\n  "scripts": {}\n}\n');
    discoverProject(root);
    const refreshedCache = JSON.parse(readFileSync(cachePath, 'utf8')) as { version?: unknown };
    expect(refreshedCache.version).toBe(3);
  });

  it('returns bounded analysis metrics without changing the project model shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-metrics-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'metrics', scripts: {} }));
    writeFileSync(join(root, 'index.ts'), 'export const value = 1;\n');

    const result = discoverProjectWithMetrics(root);

    expect(result.model.version).toBe(1);
    expect(result.metrics).toMatchObject({
      files: 2,
      modules: 1,
      cacheAvailable: false,
      cacheHit: false,
      changedFiles: 0,
    });
    expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);

    writeFileSync(join(root, 'index.ts'), 'export const value = 2;\n');
    const refreshed = discoverProjectWithMetrics(root);
    expect(refreshed.metrics.reusedModules).toBe(0);
    writeFileSync(join(root, 'README.md'), '# unchanged source set\n');
    const metadataRefresh = discoverProjectWithMetrics(root);
    expect(metadataRefresh.metrics.reusedModules).toBe(1);
  });
});
