import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { Project, SyntaxKind, type SourceFile } from 'ts-morph';
import { config } from '../config.js';

export interface ProjectFileRecord {
  path: string;
  kind: 'source' | 'test' | 'config' | 'schema' | 'migration' | 'documentation' | 'other';
  bytes: number;
}

export interface ModuleRecord {
  path: string;
  contentHash: string;
  imports: string[];
  importedSymbols: string[];
  exports: string[];
  calls: string[];
  resolvedImports: string[];
  dynamicImports: string[];
  declarations: {
    classes: number;
    functions: number;
    interfaces: number;
    types: number;
    variables: number;
  };
  directives: string[];
}

export interface CapabilitySignal {
  status: 'observed' | 'inferred';
  confidence: 'high' | 'medium' | 'low';
  packages: string[];
  files: string[];
  imports: string[];
  evidence: string[];
}

export interface ProjectModel {
  version: 1;
  project: {
    name?: string;
    packageManager?: string;
    frameworks: string[];
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    workspacePackages: {
      path: string;
      name?: string;
      private: boolean;
      scripts: Record<string, string>;
      dependencies: string[];
    }[];
  };
  files: ProjectFileRecord[];
  modules: ModuleRecord[];
  configs: string[];
  schemas: string[];
  tests: {
    files: string[];
    scripts: Record<string, string>;
  };
  git: {
    repository: boolean;
    branch?: string;
    dirty: boolean;
    changedFiles: string[];
    status: string[];
    diffStat: string;
    history: { hash: string; date: string; subject: string }[];
  };
  patterns: {
    clientComponents: string[];
    serverActions: string[];
    routeHandlers: string[];
    routeDetails: { path: string; methods: string[] }[];
    barrelFiles: string[];
    importGraphEdges: number;
  };
  capabilities: Record<string, CapabilitySignal>;
  insights: {
    layers: Record<string, string[]>;
    cycles: string[][];
    importHotspots: { module: string; count: number }[];
    boundaries: { kind: string; files: string[]; evidence: string }[];
    layerEdges: { from: string; to: string; count: number }[];
    dependencyEdges: { from: string; to: string }[];
    envReferences: { name: string; files: string[]; declared: boolean }[];
    impactPaths: {
      entrypoint: string;
      files: string[];
      layers: string[];
      boundaries: string[];
    }[];
  };
}

export interface DiscoveryMetrics {
  durationMs: number;
  files: number;
  modules: number;
  cacheAvailable: boolean;
  cacheHit: boolean;
  changedFiles: number;
  reusedModules: number;
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  '.codapult',
  '.vercel',
  'out',
  'playwright-report',
  'test-results',
  'certificates',
]);

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const DOCUMENTATION_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.txt']);
const CONFIG_NAMES = new Set([
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  '.eslintrc',
  '.prettierrc',
  'vite.config.ts',
  'vite.config.js',
  'next.config.ts',
  'next.config.js',
  'next.config.mjs',
  'webpack.config.js',
  'jest.config.ts',
  'vitest.config.ts',
  'playwright.config.ts',
]);

const discoveryCache = new Map<string, { signature: string; model: ProjectModel }>();
const discoveryReuse = new Map<string, number>();
// Bump when the persisted model shape changes; old cache entries must never
// bypass discovery and return an incomplete ProjectModel.
const DISCOVERY_CACHE_VERSION = 3;

function discoveryCachePath(root: string): string {
  return resolve(root, `.${config.appName}/guard/cache.json`);
}

function contentHash(root: string, path: string): string {
  return createHash('sha256')
    .update(readFileSync(resolve(root, path)))
    .digest('hex');
}

function ignoredFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    (name.startsWith('.env.') && name !== '.env.example') ||
    name === '.env' ||
    /\.(?:db|sqlite|sqlite3|tsbuildinfo|pem|key|p12|pfx)$/.test(name)
  );
}

export function findGuardRoot(from: string = process.cwd()): string {
  let directory = resolve(from);
  const filesystemRoot = resolve('/');
  while (directory !== filesystemRoot) {
    if (
      existsSync(resolve(directory, '.git')) ||
      existsSync(resolve(directory, 'package.json')) ||
      existsSync(resolve(directory, 'tsconfig.json')) ||
      existsSync(resolve(directory, 'jsconfig.json'))
    ) {
      return directory;
    }
    directory = dirname(directory);
  }
  return resolve(from);
}

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asStringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function packageManager(root: string): string | undefined {
  const packageJson = readJsonObject(resolve(root, 'package.json'));
  if (typeof packageJson.packageManager === 'string') return packageJson.packageManager;
  for (const [file, manager] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
  ] as const) {
    try {
      statSync(resolve(root, file));
      return manager;
    } catch {
      // Try the next lockfile.
    }
  }
  return undefined;
}

function workspacePackages(
  root: string,
  files: string[],
): ProjectModel['project']['workspacePackages'] {
  return files
    .filter((path) => path !== 'package.json' && basename(path) === 'package.json')
    .map((path) => {
      const manifest = readJsonObject(resolve(root, path));
      return {
        path: dirname(path).replaceAll('\\', '/') || '.',
        ...(typeof manifest.name === 'string' ? { name: manifest.name } : {}),
        private: manifest.private === true,
        scripts: asStringRecord(manifest.scripts),
        dependencies: Object.keys({
          ...asStringRecord(manifest.dependencies),
          ...asStringRecord(manifest.devDependencies),
          ...asStringRecord(manifest.peerDependencies),
        }).sort(),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function listFiles(root: string, directory = root): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(root, path));
    else if (entry.isFile() && !ignoredFile(path)) result.push(relative(root, path));
  }
  return result.sort();
}

function fileKind(path: string): ProjectFileRecord['kind'] {
  const name = basename(path).toLowerCase();
  if (/\.(?:test|spec)\.[^.]+$/.test(name) || path.includes('/__tests__/')) return 'test';
  if (name.includes('schema') || path.includes('/schemas/')) return 'schema';
  if (path.includes('/migrations/') || path.includes('/drizzle/')) return 'migration';
  if (DOCUMENTATION_EXTENSIONS.has(extname(name))) return 'documentation';
  if (CONFIG_NAMES.has(name) || name.includes('config')) return 'config';
  if (SOURCE_EXTENSIONS.has(extname(name))) return 'source';
  return 'other';
}

function sourceFilePath(
  root: string,
  sourceFile: SourceFile,
  projectFiles: Set<string>,
): string | undefined {
  const path = relative(root, sourceFile.getFilePath()).replaceAll('\\', '/');
  return path.startsWith('..') || !projectFiles.has(path) ? undefined : path;
}

function resolveInternalImport(
  from: string,
  importPath: string,
  modules: Set<string>,
): string | undefined {
  if (!importPath.startsWith('.')) return undefined;
  const base = normalize(join(dirname(from), importPath));
  const candidates = [
    base,
    ...[...SOURCE_EXTENSIONS].map((extension) => `${base}${extension}`),
    ...[...SOURCE_EXTENSIONS].map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => modules.has(candidate));
}

function parseModule(
  project: Project,
  root: string,
  path: string,
  projectFiles: Set<string>,
): ModuleRecord | undefined {
  if (!SOURCE_EXTENSIONS.has(extname(path))) return undefined;
  let sourceFile: SourceFile;
  try {
    sourceFile =
      project.getSourceFile(resolve(root, path)) ??
      project.addSourceFileAtPath(resolve(root, path));
  } catch {
    return undefined;
  }
  const imports: string[] = [];
  const importedSymbols: string[] = [];
  const exports: string[] = [];
  const dynamicImports: string[] = [];
  const declarations = { classes: 0, functions: 0, interfaces: 0, types: 0, variables: 0 };
  const resolvedImports = new Set<string>();
  for (const declaration of sourceFile.getImportDeclarations()) {
    const importPath = declaration.getModuleSpecifierValue();
    imports.push(importPath);
    const defaultImport = declaration.getDefaultImport()?.getText();
    if (defaultImport) importedSymbols.push(defaultImport);
    const namespaceImport = declaration.getNamespaceImport()?.getText();
    if (namespaceImport) importedSymbols.push(namespaceImport);
    for (const namedImport of declaration.getNamedImports()) {
      importedSymbols.push(namedImport.getAliasNode()?.getText() ?? namedImport.getName());
    }
    const resolved = declaration.getModuleSpecifierSourceFile();
    const resolvedPath = resolved && sourceFilePath(root, resolved, projectFiles);
    if (resolvedPath) resolvedImports.add(resolvedPath);
  }
  for (const declaration of sourceFile.getExportDeclarations()) {
    const moduleSpecifier = declaration.getModuleSpecifierValue();
    if (!moduleSpecifier) continue;
    exports.push(moduleSpecifier);
    const resolved = declaration.getModuleSpecifierSourceFile();
    const resolvedPath = resolved && sourceFilePath(root, resolved, projectFiles);
    if (resolvedPath) resolvedImports.add(resolvedPath);
  }
  declarations.classes = sourceFile.getClasses().length;
  declarations.functions = sourceFile.getFunctions().length;
  declarations.interfaces = sourceFile.getInterfaces().length;
  declarations.types = sourceFile.getTypeAliases().length;
  declarations.variables = sourceFile.getVariableStatements().length;
  const calls = sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .map((call) => call.getExpression().getText())
    .filter((expression) => /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(expression));
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression().getText();
    if (expression !== 'import' && expression !== 'require') continue;
    const argument = call.getArguments()[0];
    if (!argument.isKind(SyntaxKind.StringLiteral)) continue;
    const importPath = argument.getText().slice(1, -1);
    if (!importPath) continue;
    dynamicImports.push(importPath);
    const resolvedPath = resolveInternalImport(path, importPath, projectFiles);
    if (resolvedPath) resolvedImports.add(resolvedPath);
  }
  const directives = sourceFile
    .getStatements()
    .filter((statement) => statement.isKind(SyntaxKind.ExpressionStatement))
    .map((statement) => statement.getExpression())
    .filter((expression) => {
      if (!expression.isKind(SyntaxKind.StringLiteral)) return false;
      const value = expression.getText().slice(1, -1);
      return value === 'use client' || value === 'use server';
    })
    .map((expression) => expression.getText().slice(1, -1));
  return {
    path,
    contentHash: contentHash(root, path),
    imports: [...new Set(imports)].sort(),
    importedSymbols: [...new Set(importedSymbols)].sort(),
    exports: [...new Set(exports)].sort(),
    calls: [...new Set(calls)].sort(),
    resolvedImports: [...resolvedImports].sort(),
    dynamicImports: [...new Set(dynamicImports)].sort(),
    declarations,
    directives,
  };
}

function runGit(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
  } catch (error) {
    const stdout = (error as { stdout?: Buffer }).stdout;
    return stdout?.toString().trim() || undefined;
  }
}

function gitModel(root: string): ProjectModel['git'] {
  const branch = runGit(root, ['branch', '--show-current']);
  const status = runGit(root, ['status', '--porcelain'])?.split('\n').filter(Boolean) ?? [];
  const changed = new Set<string>([
    ...(runGit(root, ['diff', '--name-only', 'HEAD'])?.split('\n').filter(Boolean) ?? []),
    ...(runGit(root, ['ls-files', '--others', '--exclude-standard'])?.split('\n').filter(Boolean) ??
      []),
  ]);
  const history = (
    runGit(root, ['log', '-n', '30', '--date=iso-strict', '--format=%H%x1f%ad%x1f%s']) ?? ''
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', date = '', subject = ''] = line.split('\x1f');
      return { hash, date, subject };
    });
  return {
    repository: runGit(root, ['rev-parse', '--is-inside-work-tree']) === 'true',
    branch: branch || undefined,
    dirty: status.length > 0,
    changedFiles: [...changed].sort(),
    status,
    diffStat: runGit(root, ['diff', '--stat', 'HEAD']) ?? '',
    history,
  };
}

function inferFrameworks(
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
): string[] {
  const all = new Set([...Object.keys(dependencies), ...Object.keys(devDependencies)]);
  const known: readonly (readonly [string, string])[] = [
    ['next', 'Next.js'],
    ['react', 'React'],
    ['vue', 'Vue'],
    ['svelte', 'Svelte'],
    ['express', 'Express'],
    ['fastify', 'Fastify'],
    ['@nestjs/core', 'NestJS'],
    ['drizzle-orm', 'Drizzle'],
    ['prisma', 'Prisma'],
  ] as const;
  const frameworks = known.filter(([dependency]) => all.has(dependency)).map(([, name]) => name);
  if (all.has('vite') && !all.has('next')) frameworks.push('Vite');
  return frameworks;
}

function layerForPath(path: string): string {
  const segments = path.toLowerCase().split('/');
  if (segments.includes('__tests__') || /\.(?:test|spec)\./.test(path)) return 'tests';
  if (segments.some((segment) => ['app', 'pages', 'routes', 'api'].includes(segment))) {
    return 'routes';
  }
  if (segments.includes('components') || segments.includes('ui')) return 'ui';
  if (segments.some((segment) => ['domain', 'entities', 'models'].includes(segment))) {
    return 'domain';
  }
  if (
    segments.some((segment) =>
      ['services', 'use-cases', 'usecases', 'application'].includes(segment),
    )
  ) {
    return 'application';
  }
  if (
    segments.some((segment) =>
      ['db', 'database', 'repositories', 'adapters', 'infrastructure', 'lib'].includes(segment),
    )
  ) {
    return 'infrastructure';
  }
  if (segments.some((segment) => ['config', 'configs', 'configuration'].includes(segment))) {
    return 'config';
  }
  return 'other';
}

/** Build the internal module graph from AST resolution plus conservative fallback resolution.
 *
 * TypeScript resolution is authoritative when available, but it is not complete for every
 * JavaScript/configuration shape. The fallback must be additive: using it only when there are
 * no resolved imports silently drops unresolved edges from mixed projects.
 */
export function buildModuleTargetGraph(modules: ModuleRecord[]): Map<string, string[]> {
  const moduleSet = new Set(modules.map((candidate) => candidate.path));
  return new Map(
    modules.map((module) => {
      const targets = new Set(module.resolvedImports.filter((path) => moduleSet.has(path)));
      for (const importPath of [...module.imports, ...module.dynamicImports]) {
        const target = resolveInternalImport(module.path, importPath, moduleSet);
        if (target) targets.add(target);
      }
      return [module.path, [...targets].sort()] as const;
    }),
  );
}

function findCycles(modules: ModuleRecord[]): string[][] {
  const graph = buildModuleTargetGraph(modules);
  const indexByNode = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let index = 0;
  const visit = (node: string): void => {
    indexByNode.set(node, index);
    lowLink.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indexByNode.has(next)) {
        visit(next);
        lowLink.set(node, Math.min(lowLink.get(node) ?? 0, lowLink.get(next) ?? 0));
      } else if (onStack.has(next)) {
        lowLink.set(node, Math.min(lowLink.get(node) ?? 0, indexByNode.get(next) ?? 0));
      }
    }
    if (lowLink.get(node) !== indexByNode.get(node)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member) {
        onStack.delete(member);
        component.push(member);
      }
    } while (member !== node);
    if (component.length > 1 || (component.length === 1 && graph.get(node)?.includes(node))) {
      components.push(component.sort());
    }
  };
  for (const module of modules) {
    if (!indexByNode.has(module.path)) visit(module.path);
  }
  return components.sort((a, b) => a.join().localeCompare(b.join()));
}

function buildImpactPaths(
  modules: ModuleRecord[],
  routeHandlers: string[],
  serverActions: string[],
): ProjectModel['insights']['impactPaths'] {
  const moduleByPath = new Map(modules.map((module) => [module.path, module]));
  const graph = buildModuleTargetGraph(modules);
  const entrypoints = [...new Set([...routeHandlers, ...serverActions])]
    .filter((path) => moduleByPath.has(path))
    .sort()
    .slice(0, 200);
  return entrypoints.map((entrypoint) => {
    const queue = [entrypoint];
    const visited = new Set<string>();
    while (queue.length > 0 && visited.size < 200) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      const module = moduleByPath.get(current);
      if (!module) continue;
      for (const target of graph.get(module.path) ?? []) {
        if (!visited.has(target) && moduleByPath.has(target)) queue.push(target);
      }
    }
    const files = [...visited].sort();
    const layers = [...new Set(files.map(layerForPath))];
    const boundaries = [
      ...new Set(
        files.flatMap((file) => {
          const module = moduleByPath.get(file);
          return (
            module?.directives.filter(
              (directive) => directive === 'use client' || directive === 'use server',
            ) ?? []
          );
        }),
      ),
    ].sort();
    return { entrypoint, files, layers, boundaries };
  });
}

function detectCapabilities(
  files: ProjectFileRecord[],
  modules: ModuleRecord[],
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
  scripts: Record<string, string>,
): Record<string, CapabilitySignal> {
  const allPackages = Object.keys({ ...dependencies, ...devDependencies });
  const evidenceFiles = files
    .filter((file) => file.kind !== 'documentation')
    .map((file) => file.path);
  const allImports = [...new Set(modules.flatMap((module) => module.imports))].sort();
  const packageSignal = (
    packagePattern: RegExp,
    filePattern: RegExp,
    importPattern: RegExp,
    evidence: string,
  ): CapabilitySignal => {
    const packages = allPackages.filter((name) => packagePattern.test(name));
    const matchedFiles = evidenceFiles.filter((file) => filePattern.test(file));
    const imports = allImports.filter((importPath) => importPattern.test(importPath));
    return {
      status: matchedFiles.length > 0 || imports.length > 0 ? 'observed' : 'inferred',
      confidence:
        packages.length > 0 && (matchedFiles.length > 0 || imports.length > 0)
          ? 'high'
          : packages.length > 0 || matchedFiles.length > 0 || imports.length > 0
            ? 'medium'
            : 'low',
      packages,
      files: matchedFiles,
      imports,
      evidence: [
        ...(packages.length > 0 ? [`dependency: ${packages.join(', ')}`] : []),
        ...(matchedFiles.length > 0 ? [`file pattern: ${filePattern.source}`] : []),
        ...(imports.length > 0 ? [`import pattern: ${importPattern.source}`] : []),
        ...(packages.length > 0 || matchedFiles.length > 0 || imports.length > 0 ? [evidence] : []),
      ],
    };
  };

  const capabilities: Record<string, CapabilitySignal> = {
    runtime: {
      status: 'observed',
      confidence: 'high',
      packages: allPackages.filter((name) =>
        /^(next|react|vue|svelte|express|fastify|@nestjs\/core)$/.test(name),
      ),
      files: files.filter((file) => file.kind === 'config').map((file) => file.path),
      imports: allImports.filter((importPath) =>
        /^(next|react|vue|svelte|express|fastify)(\/|$)/.test(importPath),
      ),
      evidence: ['package metadata and runtime imports'],
    },
    routing: packageSignal(
      /^next$/,
      /(?:^|\/)(?:route|page)\.[cm]?[jt]sx?$/,
      /^(next\/navigation|next\/server|next\/headers)$/,
      'route and page conventions',
    ),
    'server-client-boundaries': {
      status: 'observed',
      confidence: 'high',
      packages: [],
      files: modules
        .filter((module) =>
          module.directives.some(
            (directive) => directive === 'use client' || directive === 'use server',
          ),
        )
        .map((module) => module.path),
      imports: [],
      evidence: ['use client/use server directives'],
    },
    persistence: packageSignal(
      /^(?:drizzle-orm|drizzle-kit|prisma|@prisma\/client|typeorm|sequelize|mongoose|knex|@libsql\/client)$/,
      /(?:^|\/)(?:db|database|repositories|schema|schemas|migrations|drizzle)(?:\/|[^/]*$)/i,
      /^(?:@prisma\/client|prisma|drizzle-orm|drizzle-kit|typeorm|sequelize|mongoose|knex|@libsql\/client)(\/|$)|(?:^|\/)(?:db|database)(\/|$)/i,
      'database and ORM conventions',
    ),
    identity: packageSignal(
      /auth|identity|session|kinde|clerk|lucia|next-auth|better-auth/i,
      /(?:^|\/)(?:auth|authentication|identity|session)(?:\/|[^/]*$)/i,
      /(?:^|\/)(?:auth|authentication|identity|session)(?:\/|$)/i,
      'identity and session conventions',
    ),
    payments: packageSignal(
      /stripe|lemonsqueezy|paddle|paypal|braintree|polar/i,
      /(?:^|\/)(?:billing|payment|payments|checkout|subscription|subscriptions)(?:\/|[^/]*$)/i,
      /stripe|lemonsqueezy|paddle|paypal|braintree|polar/i,
      'payment provider conventions',
    ),
    email: packageSignal(
      /resend|react-email|nodemailer|postmark|sendgrid|mailgun/i,
      /(?:^|\/)(?:email|emails|mail|templates)(?:\/|[^/]*$)/i,
      /resend|react-email|nodemailer|postmark|sendgrid|mailgun/i,
      'email delivery and template conventions',
    ),
    ai: packageSignal(
      /^(?:ai|openai|anthropic|@ai-sdk\/|@langchain\/)/i,
      /(?:^|\/)(?:ai|agents|prompts|embeddings|rag|llm)(?:\/|[^/]*$)/i,
      /^(?:ai|openai|anthropic|@ai-sdk\/|@langchain\/)/i,
      'AI and model integration conventions',
    ),
    jobs: packageSignal(
      /bullmq|agenda|inngest|trigger\.dev|@temporalio|graphile-worker|bee-queue|pg-boss/i,
      /(?:^|\/)(?:jobs|queues|queue|workers|worker|background|tasks)(?:\/|[^/]*$)/i,
      /bullmq|agenda|inngest|trigger\.dev|@temporalio|graphile-worker|bee-queue|pg-boss/i,
      'background job and queue conventions',
    ),
    env: packageSignal(
      /dotenv|envalid|convex|@t3-oss\/env/i,
      /(?:^|\/)(?:env|environment)(?:\/|[^/]*$)|(?:^|\/)\.env(?:\.example)?$|(?:^|\/)(?:config|configuration)\/env(?:[^/]*)$/i,
      /dotenv|envalid|@t3-oss\/env/i,
      'environment and configuration conventions',
    ),
    deployment: packageSignal(
      /vercel|docker|pulumi|terraform|kubernetes|helm|aws-sdk|@aws-sdk\//i,
      /(?:^|\/)(?:Dockerfile|docker-compose|infra|terraform|pulumi|helm|k8s|\.github\/workflows)(?:\/|[^/]*$)/i,
      /vercel|pulumi|terraform|kubernetes|helm|aws-sdk|@aws-sdk\//i,
      'deployment and infrastructure conventions',
    ),
    testing: packageSignal(
      /vitest|jest|playwright|cypress|mocha|ava/i,
      /(?:^|\/)(?:__tests__|tests?|e2e)(?:\/|[^/]*$)|\.(?:test|spec)\./i,
      /vitest|jest|playwright|cypress|mocha|ava/i,
      'test runner and test layout conventions',
    ),
    observability: packageSignal(
      /sentry|opentelemetry|datadog|pino|winston|otel/i,
      /(?:^|\/)(?:instrumentation|observability|monitoring|logging|telemetry)(?:\/|[^/]*$)/i,
      /sentry|opentelemetry|datadog|pino|winston|otel/i,
      'logging, tracing, and error monitoring conventions',
    ),
    storage: packageSignal(
      /s3|minio|r2|uploadthing|cloudinary|sharp/i,
      /(?:^|\/)(?:storage|uploads?|media|assets)(?:\/|[^/]*$)/i,
      /s3|minio|r2|uploadthing|cloudinary/i,
      'file and object storage conventions',
    ),
    'graphql-rpc': packageSignal(
      /graphql|trpc|grpc|@connectrpc\//i,
      /(?:^|\/)(?:graphql|trpc|rpc)(?:\/|[^/]*$)/i,
      /graphql|trpc|grpc|@connectrpc\//i,
      'GraphQL and RPC conventions',
    ),
    i18n: packageSignal(
      /next-intl|i18next|react-i18next|lingui/i,
      /(?:^|\/)(?:i18n|locales?|messages|translations?)(?:\/|[^/]*$)/i,
      /next-intl|i18next|react-i18next|lingui/i,
      'internationalization conventions',
    ),
    dependencies: {
      status: 'observed',
      confidence: 'high',
      packages: allPackages,
      files: files
        .filter((file) => /(?:package\.json|lock$|lock\.yaml$)/i.test(file.path))
        .map((file) => file.path),
      imports: [],
      evidence: ['package manifest and lockfile metadata'],
    },
    configs: packageSignal(
      /^(?:cosmiconfig|convict|config|dotenv|jiti|tsx|ts-node)$/i,
      /(?:^|\/)(?:config|configs|configuration)(?:\/|[^/]*$)|(?:^|\/)[^/]+\.config\.[cm]?[jt]sx?$/i,
      /^(?:cosmiconfig|convict|config|dotenv|jiti|tsx|ts-node)(\/|$)/i,
      'configuration files and loaders',
    ),
    security: packageSignal(
      /(?:helmet|csrf|rate-limit|ratelimit|clerk|lucia|next-auth|better-auth|sentry|semgrep|zod|valibot|jose|bcrypt|argon2)/i,
      /(?:^|\/)(?:security|middleware|auth|authentication|permissions?|policies?|crypto)(?:\/|[^/]*$)/i,
      /(?:helmet|csrf|rate-limit|ratelimit|jose|bcrypt|argon2|sentry)(\/|$)/i,
      'security, validation, and permission conventions',
    ),
    webhooks: packageSignal(
      /stripe|svix|webhooks?[-/]?js|inngest|resend|paypal|paddle/i,
      /(?:^|\/)(?:webhooks?|events?)(?:\/|[^/]*$)/i,
      /(?:webhooks?|events?)(\/|$)/i,
      'webhook and event receiver conventions',
    ),
    cache: packageSignal(
      /redis|ioredis|upstash|lru-cache|node-cache|react-cache/i,
      /(?:^|\/)(?:cache|caching|redis)(?:\/|[^/]*$)/i,
      /redis|ioredis|upstash|lru-cache|node-cache/i,
      'cache and key-value storage conventions',
    ),
    analytics: packageSignal(
      /posthog|segment|mixpanel|amplitude|plausible|google-analytics|vercel\/analytics/i,
      /(?:^|\/)(?:analytics|tracking|telemetry)(?:\/|[^/]*$)/i,
      /posthog|segment|mixpanel|amplitude|plausible|analytics/i,
      'product analytics and tracking conventions',
    ),
    search: packageSignal(
      /algoliasearch|elasticsearch|opensearch|meilisearch|typesense|instantsearch/i,
      /(?:^|\/)(?:search|indexing|indexes)(?:\/|[^/]*$)/i,
      /algoliasearch|elasticsearch|opensearch|meilisearch|typesense|instantsearch/i,
      'search and indexing conventions',
    ),
    content: packageSignal(
      /contentlayer|mdx|remark|rehype|sanity|contentful|strapi|payload/i,
      /(?:^|\/)(?:content|cms|mdx|posts?|articles?)(?:\/|[^/]*$)/i,
      /contentlayer|remark|rehype|sanity|contentful|strapi|payload/i,
      'content and CMS conventions',
    ),
    tooling: packageSignal(
      /^(?:typescript|eslint|prettier|biome|dependency-cruiser|madge|knip|semgrep|snyk|npm-check-updates|lefthook|husky)$/i,
      /(?:^|\/)(?:\.github\/workflows|\.husky|\.lefthook|scripts?|tools?)(?:\/|[^/]*$)/i,
      /^(?:typescript|eslint|prettier|biome|dependency-cruiser|madge|knip|semgrep|snyk|lefthook|husky)(\/|$)/i,
      'static analysis, formatting, dependency graph, and hook tooling',
    ),
  };
  const scriptNames = Object.keys(scripts).filter((name) =>
    /deploy|worker|job|queue|seed|migrat/i.test(name),
  );
  if (scriptNames.length > 0) {
    capabilities.jobs = {
      ...capabilities.jobs,
      evidence: [...capabilities.jobs.evidence, `scripts: ${scriptNames.join(', ')}`],
    };
  }
  return Object.fromEntries(
    Object.entries(capabilities).filter(
      ([, signal]) =>
        signal.packages.length > 0 || signal.files.length > 0 || signal.imports.length > 0,
    ),
  );
}

function buildInsights(
  root: string,
  files: ProjectFileRecord[],
  modules: ModuleRecord[],
  sourceFiles: string[],
  dependencies: Record<string, string>,
  astProject: Project,
): ProjectModel['insights'] {
  const layers: Record<string, string[]> = {};
  for (const file of files.filter((candidate) =>
    ['source', 'test', 'schema', 'migration'].includes(candidate.kind),
  )) {
    const layer = layerForPath(file.path);
    (layers[layer] ??= []).push(file.path);
  }
  for (const paths of Object.values(layers)) paths.sort();
  const importCounts = new Map<string, number>();
  for (const module of modules) {
    for (const importPath of module.imports) {
      if (!importPath.startsWith('.') && !importPath.startsWith('@/')) {
        importCounts.set(importPath, (importCounts.get(importPath) ?? 0) + 1);
      }
    }
  }
  const importHotspots = [...importCounts.entries()]
    .map(([module, count]) => ({ module, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.module.localeCompare(b.module)))
    .slice(0, 30);
  const boundaries: ProjectModel['insights']['boundaries'] = [];
  const clientFiles = modules
    .filter((module) => module.directives.includes('use client'))
    .map((module) => module.path);
  if (clientFiles.length > 0) {
    boundaries.push({ kind: 'client', files: clientFiles, evidence: 'use client directive' });
  }
  const serverFiles = modules
    .filter((module) => module.directives.includes('use server'))
    .map((module) => module.path);
  if (serverFiles.length > 0) {
    boundaries.push({ kind: 'server', files: serverFiles, evidence: 'use server directive' });
  }
  const ormPackages = Object.keys(dependencies).filter((name) =>
    ['drizzle-orm', 'prisma', 'typeorm', 'sequelize', 'mongoose', 'knex'].includes(name),
  );
  if (ormPackages.length > 0) {
    boundaries.push({
      kind: 'persistence',
      files: files
        .filter((file) => file.kind === 'schema' || layerForPath(file.path) === 'infrastructure')
        .map((file) => file.path),
      evidence: `ORM dependency: ${ormPackages.join(', ')}`,
    });
  }
  const moduleGraph = buildModuleTargetGraph(modules);
  const dependencyEdges = modules.flatMap(
    (module) =>
      moduleGraph.get(module.path)?.map((target) => ({ from: module.path, to: target })) ?? [],
  );
  const edgeCounts = new Map<string, number>();
  for (const module of modules) {
    const targets = moduleGraph.get(module.path) ?? [];
    for (const target of targets) {
      const edge = `${layerForPath(module.path)}\0${layerForPath(target)}`;
      edgeCounts.set(edge, (edgeCounts.get(edge) ?? 0) + 1);
    }
  }
  const layerEdges = [...edgeCounts.entries()]
    .map(([edge, count]) => {
      const [from, to] = edge.split('\0');
      return { from: from ?? 'unknown', to: to ?? 'unknown', count };
    })
    .sort((a, b) =>
      b.count !== a.count
        ? b.count - a.count
        : `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`),
    );
  return {
    layers,
    cycles: findCycles(modules),
    importHotspots,
    boundaries,
    layerEdges,
    dependencyEdges,
    impactPaths: buildImpactPaths(
      modules,
      sourceFiles.filter((path) => /(?:^|\/)route\.[cm]?[jt]sx?$/.test(path)),
      modules
        .filter((module) => module.directives.includes('use server'))
        .map((module) => module.path),
    ),
    envReferences: sourceFiles
      .reduce<{ name: string; files: string[] }[]>((references, path) => {
        const sourceFile = astProject.getSourceFile(resolve(root, path));
        if (!sourceFile) return references;
        const names = new Set<string>();
        for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
          const expression = access.getExpression().getText();
          const name = access.getName();
          if (
            (expression === 'process.env' || expression === 'env') &&
            /^[A-Z][A-Z0-9_]*$/.test(name)
          ) {
            names.add(name);
          }
        }
        for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
          if (access.getExpression().getText() !== 'process.env') continue;
          const argument = access.getArgumentExpression();
          if (!argument?.isKind(SyntaxKind.StringLiteral)) continue;
          const name = argument.getLiteralValue();
          if (typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name)) names.add(name);
        }
        for (const name of names) {
          const reference = references.find((item) => item.name === name);
          if (reference) reference.files.push(path);
          else references.push({ name, files: [path] });
        }
        return references;
      }, [])
      .map((reference) => ({
        ...reference,
        files: [...new Set(reference.files)].sort(),
        declared: (() => {
          try {
            const example = readFileSync(resolve(root, '.env.example'), 'utf8');
            return new RegExp(`^${reference.name}=`, 'm').test(example);
          } catch {
            return false;
          }
        })(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function createAstProject(root: string): Project {
  const tsConfigPath = resolve(root, 'tsconfig.json');
  try {
    return existsSync(tsConfigPath)
      ? new Project({ tsConfigFilePath: tsConfigPath })
      : new Project({ skipAddingFilesFromTsConfig: true });
  } catch {
    return new Project({ skipAddingFilesFromTsConfig: true });
  }
}

export function discoverProject(
  root: string,
  options: { persistCache?: boolean } = {},
): ProjectModel {
  const packageJson = readJsonObject(resolve(root, 'package.json'));
  const dependencies = asStringRecord(packageJson.dependencies);
  const devDependencies = asStringRecord(packageJson.devDependencies);
  const scripts = asStringRecord(packageJson.scripts);
  const allFiles = listFiles(root);
  const signature = JSON.stringify([
    JSON.stringify(packageJson),
    allFiles.map((path) => {
      const stat = statSync(resolve(root, path));
      return [path, stat.size, stat.mtimeMs];
    }),
    runGit(root, ['rev-parse', 'HEAD']),
    runGit(root, ['status', '--porcelain']),
  ]);
  const cacheKey = resolve(root);
  const cached = discoveryCache.get(cacheKey);
  if (cached?.signature === signature) {
    discoveryReuse.set(cacheKey, cached.model.modules.length);
    return cached.model;
  }
  let previousModel = cached?.model;
  try {
    const persisted = JSON.parse(readFileSync(discoveryCachePath(root), 'utf8')) as {
      version?: unknown;
      signature?: unknown;
      model?: unknown;
    };
    if (
      persisted.version === DISCOVERY_CACHE_VERSION &&
      persisted.model !== null &&
      typeof persisted.model === 'object' &&
      (persisted.model as { version?: unknown }).version === 1
    ) {
      previousModel = persisted.model as ProjectModel;
      if (persisted.signature === signature) {
        discoveryCache.set(cacheKey, { signature, model: previousModel });
        discoveryReuse.set(cacheKey, previousModel.modules.length);
        return previousModel;
      }
    }
  } catch {
    // A missing or invalid cache is a normal cold-start path.
  }
  const files = allFiles.map((path) => ({
    path,
    kind: fileKind(path),
    bytes: statSync(resolve(root, path)).size,
  }));
  const projectFiles = new Set(files.map((file) => file.path));
  const astProject = createAstProject(root);
  const previousModules = new Map(previousModel?.modules.map((module) => [module.path, module]));
  const currentShape = files
    .filter((file) => file.kind === 'source' || file.kind === 'test')
    .map((file) => `${file.kind}:${file.path}`)
    .join('\n');
  const previousShape = previousModel?.files
    .filter((file) => file.kind === 'source' || file.kind === 'test')
    .map((file) => `${file.kind}:${file.path}`)
    .join('\n');
  const changedGitFiles = [
    ...(runGit(root, ['diff', '--name-only', 'HEAD'])?.split('\n') ?? []),
    ...(runGit(root, ['ls-files', '--others', '--exclude-standard'])?.split('\n') ?? []),
  ].filter(Boolean);
  const resolutionConfigChanged = changedGitFiles.some((path) =>
    /(?:^|\/)(?:tsconfig|jsconfig)\.json$/.test(path),
  );
  const canReuseModules = previousShape === currentShape && !resolutionConfigChanged;
  let reusedModules = 0;
  const modules = files
    .filter((file) => file.kind === 'source' || file.kind === 'test')
    .map((file) => {
      const previous = canReuseModules ? previousModules.get(file.path) : undefined;
      if (previous?.contentHash === contentHash(root, file.path)) {
        reusedModules += 1;
        return previous;
      }
      return parseModule(astProject, root, file.path, projectFiles);
    })
    .filter((module): module is ModuleRecord => module !== undefined);
  const sourceFiles = files.filter((file) => file.kind === 'source').map((file) => file.path);
  const testFiles = files.filter((file) => file.kind === 'test').map((file) => file.path);
  const configs = files.filter((file) => file.kind === 'config').map((file) => file.path);
  const schemas = files.filter((file) => file.kind === 'schema').map((file) => file.path);
  const testScripts = Object.fromEntries(
    Object.entries(scripts).filter(([name]) => /test|check|lint|type/.test(name)),
  );
  const routeDetails = sourceFiles
    .filter((path) => /(?:^|\/)route\.[cm]?[jt]sx?$/.test(path))
    .map((path) => {
      const sourceFile = astProject.getSourceFile(resolve(root, path));
      const methods = new Set<string>();
      for (const declaration of sourceFile?.getFunctions() ?? []) {
        const name = declaration.getName();
        if (declaration.isExported() && name && HTTP_METHODS.has(name)) methods.add(name);
      }
      for (const statement of sourceFile?.getVariableStatements() ?? []) {
        if (!statement.isExported()) continue;
        for (const declaration of statement.getDeclarations()) {
          const name = declaration.getName();
          if (HTTP_METHODS.has(name)) methods.add(name);
        }
      }
      for (const name of sourceFile?.getExportedDeclarations().keys() ?? []) {
        if (HTTP_METHODS.has(name)) methods.add(name);
      }
      return { path, methods: [...methods].sort() };
    });
  const model: ProjectModel = {
    version: 1,
    project: {
      name: typeof packageJson.name === 'string' ? packageJson.name : undefined,
      packageManager: packageManager(root),
      frameworks: inferFrameworks(dependencies, devDependencies),
      scripts,
      dependencies,
      devDependencies,
      workspacePackages: workspacePackages(root, allFiles),
    },
    files,
    modules,
    configs,
    schemas,
    tests: { files: testFiles, scripts: testScripts },
    capabilities: detectCapabilities(files, modules, dependencies, devDependencies, scripts),
    git: gitModel(root),
    patterns: {
      clientComponents: modules
        .filter((module) => module.directives.includes('use client'))
        .map((module) => module.path),
      serverActions: modules
        .filter((module) => module.directives.includes('use server'))
        .map((module) => module.path),
      routeHandlers: sourceFiles.filter((path) => /(?:^|\/)route\.[cm]?[jt]sx?$/.test(path)),
      routeDetails,
      barrelFiles: sourceFiles.filter((path) => /(?:^|\/)index\.[cm]?[jt]s$/.test(path)),
      importGraphEdges: modules.reduce((count, module) => count + module.imports.length, 0),
    },
    insights: buildInsights(root, files, modules, sourceFiles, dependencies, astProject),
  };
  discoveryCache.set(cacheKey, { signature, model });
  discoveryReuse.set(cacheKey, reusedModules);
  if (options.persistCache ?? existsSync(resolve(root, `.${config.appName}/guard`))) {
    try {
      mkdirSync(resolve(root, `.${config.appName}/guard`), { recursive: true });
      const cachePath = discoveryCachePath(root);
      const temporaryPath = `${cachePath}.tmp-${process.pid}`;
      writeFileSync(
        temporaryPath,
        `${JSON.stringify({ version: DISCOVERY_CACHE_VERSION, signature, model }, null, 2)}\n`,
        'utf8',
      );
      renameSync(temporaryPath, cachePath);
    } catch {
      // Discovery remains usable when the optional cache cannot be written.
    }
  }
  return model;
}

export function discoverProjectWithMetrics(
  root: string,
  options: { persistCache?: boolean } = {},
): { model: ProjectModel; metrics: DiscoveryMetrics } {
  const startedAt = Date.now();
  const cacheHit = discoveryCache.has(resolve(root));
  const model = discoverProject(root, options);
  return {
    model,
    metrics: {
      durationMs: Math.max(0, Date.now() - startedAt),
      files: model.files.length,
      modules: model.modules.length,
      cacheAvailable: existsSync(discoveryCachePath(root)),
      cacheHit,
      changedFiles: model.git.changedFiles.length,
      reusedModules: discoveryReuse.get(resolve(root)) ?? 0,
    },
  };
}
