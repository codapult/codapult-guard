import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const cli = resolve(process.env.GUARD_CLI ?? 'dist/cli/index.js');
const root = resolve(process.env.GUARD_FIXTURES_ROOT ?? '../guard-fixtures');
const requested = process.env.GUARD_SMOKE_PROJECTS?.split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const projects = requested?.length
  ? requested
  : ['next-learn', 'vite-react-ts-starter', 'hono-node-server', 'changesets', 'express'];

function run(project, args) {
  try {
    const output = execFileSync(process.execPath, [cli, ...args], {
      cwd: project,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    if (!output.trim()) {
      throw new Error('The host denied spawning the CLI child process or it returned no output.');
    }
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${args.join(' ')} failed in ${project}: ${message}`, { cause: error });
  }
}

const results = [];
const packExpectations = {
  'next-learn': { includes: ['nextjs'], excludes: ['react'] },
  'vite-react-ts-starter': { includes: ['react'], excludes: ['nextjs', 'ai'] },
  'hono-node-server': { excludes: ['ai'] },
  express: { excludes: ['ai'] },
};
for (const name of projects) {
  const project = join(root, name);
  if (!existsSync(join(project, 'package.json'))) {
    results.push({ project: name, status: 'missing' });
    continue;
  }
  const initialized = existsSync(join(project, '.codapult/guard/baseline.json'));
  if (!initialized) run(project, ['init']);
  const doctor = JSON.parse(run(project, ['doctor', '--json']));
  const verify = JSON.parse(run(project, ['verify', '--no-project-checks', '--json']));
  const architecture = JSON.parse(
    readFileSync(join(project, '.codapult/guard/architecture.json'), 'utf8'),
  );
  const packs = (architecture.packs ?? []).map((pack) => pack.id);
  const expectation = packExpectations[name];
  const packMismatch = expectation
    ? [
        ...(expectation.includes ?? [])
          .filter((pack) => !packs.includes(pack))
          .map((pack) => `missing:${pack}`),
        ...(expectation.excludes ?? [])
          .filter((pack) => packs.includes(pack))
          .map((pack) => `unexpected:${pack}`),
      ]
    : [];
  results.push({
    project: name,
    initialized,
    doctor: doctor.status,
    verify: verify.status,
    findings: verify.architecture?.findings?.length ?? 0,
    packs,
    packMismatch,
  });
}

console.log(JSON.stringify(results, null, 2));
if (
  results.some(
    (result) =>
      result.status === 'missing' ||
      result.doctor !== 'ok' ||
      result.verify !== 'ok' ||
      result.packMismatch?.length,
  )
) {
  process.exitCode = 1;
}
