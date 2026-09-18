import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

// Maintainer-only harness. It is intentionally outside Guard and its CI smoke job.
const root = resolve(process.env.GUARD_FIXTURES_ROOT ?? '../guard-fixtures');
const selected = process.env.GUARD_NATIVE_PROJECTS?.split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const matrix = {
  'next-learn': {
    install: ['pnpm', ['install', '--frozen-lockfile']],
    command: ['pnpm', ['run', 'test']],
  },
  'vite-react-ts-starter': {
    install: ['pnpm', ['install', '--frozen-lockfile']],
    command: ['pnpm', ['run', 'test', '--', '--run']],
  },
  changesets: {
    install: ['pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']],
    command: ['pnpm', ['run', 'check-all']],
    env: { COREPACK_ENABLE_PROJECT_SPEC: '0' },
  },
  'hono-node-server': {
    install: ['pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']],
    command: ['pnpm', ['run', 'test', '--', '--run']],
  },
  express: {
    install: ['npm', ['install', '--no-package-lock', '--ignore-scripts']],
    command: ['npm', ['test']],
  },
};
const projects = selected?.length ? selected : Object.keys(matrix);
const results = [];

function run(project, [program, args], env = {}) {
  execFileSync(program, args, {
    cwd: project,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    timeout: 900_000,
  });
}

for (const name of projects) {
  const project = join(root, name);
  const config = matrix[name];
  if (!config || !existsSync(join(project, 'package.json'))) {
    results.push({ project: name, status: 'missing' });
    continue;
  }
  const result = {
    project: name,
    status: 'passed',
    install: config.install.join(' '),
    command: config.command.join(' '),
  };
  try {
    if (process.env.GUARD_NATIVE_INSTALL === '1') run(project, config.install, config.env);
    run(project, config.command, config.env);
  } catch (error) {
    result.status = 'failed';
    result.error = error instanceof Error ? error.message : String(error);
  }
  results.push(result);
}

console.log(JSON.stringify(results, null, 2));
if (results.some((result) => result.status !== 'passed')) process.exitCode = 1;
