import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve(process.env.GUARD_CLI ?? 'dist/cli/index.js');
const fixtures = resolve(process.env.GUARD_LOCAL_FIXTURES ?? 'fixtures');
const names = (
  process.env.GUARD_ADVERSARIAL_FIXTURES ??
  'aliases,re-exports,dynamic-imports,monorepo,package-exports,module-boundaries'
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function run(project, args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: project,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
}

const failures = [];
for (const name of names) {
  const source = join(fixtures, name);
  if (!existsSync(source)) {
    failures.push(`${name}: fixture is missing`);
    continue;
  }
  const project = mkdtempSync(join(tmpdir(), `guard-adversarial-${name}-`));
  try {
    cpSync(source, project, { recursive: true });
    run(project, ['init']);
    const model = JSON.parse(readFileSync(join(project, '.codapult/guard/project.json'), 'utf8'));
    if (model.files.length === 0) failures.push(`${name}: discovery returned no files`);
    if (name === 'monorepo' && model.project.workspacePackages.length < 2)
      failures.push(`${name}: workspace packages were not discovered`);
    if (
      name === 'dynamic-imports' &&
      !model.modules.some((module) => module.dynamicImports.length > 0)
    )
      failures.push(`${name}: dynamic imports were not recorded`);
    if (name === 're-exports' && !model.patterns.barrelFiles.length)
      failures.push(`${name}: barrel file was not recorded`);
    if (
      name === 'package-exports' &&
      !model.project.workspacePackages.some((item) => (item.exports ?? []).includes('./db'))
    )
      failures.push(`${name}: package exports were not recorded`);
    if (
      name === 'module-boundaries' &&
      !model.modules.some((module) => module.dynamicImports.includes('./shared.js'))
    )
      failures.push(`${name}: relative module edge was not recorded`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (!process.env.GUARD_KEEP_ADVERSARIAL_PROJECTS)
      rmSync(project, { recursive: true, force: true });
    else console.error(`kept adversarial project: ${project}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log(`Guard adversarial fixtures passed: ${names.join(', ')}`);
