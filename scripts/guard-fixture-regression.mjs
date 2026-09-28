import {
  closeSync,
  cpSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const cli = resolve(process.env.GUARD_CLI ?? 'dist/cli/index.js');
const fixturesRoot = resolve(process.env.GUARD_FIXTURES_ROOT ?? '../guard-fixtures');
const projects = (
  process.env.GUARD_SMOKE_PROJECTS ?? 'next-learn,vite-react-ts-starter,hono-node-server'
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

function runAllowFailure(project, args) {
  const outputDir = mkdtempSync(join(tmpdir(), 'guard-regression-output-'));
  const stdoutPath = join(outputDir, 'stdout');
  const stderrPath = join(outputDir, 'stderr');
  const stdout = openSync(stdoutPath, 'w');
  const stderr = openSync(stderrPath, 'w');
  try {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: project,
      stdio: ['ignore', stdout, stderr],
      timeout: 120_000,
    });
    closeSync(stdout);
    closeSync(stderr);
    return {
      code: result.status ?? 1,
      signal: result.signal,
      output: readFileSync(stdoutPath, 'utf8'),
      error: readFileSync(stderrPath, 'utf8'),
    };
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

const failures = [];
for (const name of projects) {
  const source = join(fixturesRoot, name);
  if (!existsSync(join(source, 'package.json'))) {
    failures.push(`${name}: fixture is missing`);
    continue;
  }
  const project = mkdtempSync(join(tmpdir(), `guard-regression-${name}-`));
  try {
    cpSync(source, project, { recursive: true });
    rmSync(join(project, '.codapult'), { recursive: true, force: true });
    run(project, ['init']);
    const rulesPath = join(project, '.codapult/guard/rules.json');
    const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
    rules.rules.push({
      id: 'fixture-regression-boundary',
      description: 'Fixture regression must detect this forbidden import.',
      severity: 'error',
      kind: 'forbidden-import',
      patterns: ['./server-only'],
      files: ['guard-regression-client.ts'],
      status: 'active',
    });
    writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`);
    writeFileSync(join(project, 'guard-regression-client.ts'), "import './server-only';\n");
    writeFileSync(join(project, 'server-only.ts'), 'export const serverOnly = true;\n');
    const check = runAllowFailure(project, ['check', '--changed', '--json']);
    const output = check.output;
    let result;
    try {
      result = JSON.parse(output);
    } catch (error) {
      throw new Error(
        `invalid Guard JSON output (exit ${check.code}, signal ${check.signal ?? 'none'}): ${JSON.stringify(output.slice(0, 500))}${check.error ? ` stderr: ${JSON.stringify(check.error.slice(0, 500))}` : ''}`,
        {
          cause: error,
        },
      );
    }
    if (
      check.code === 0 ||
      !result.report.findings.some((finding) => finding.ruleId === 'fixture-regression-boundary')
    ) {
      failures.push(`${name}: Guard did not detect the injected violation`);
    }
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (!process.env.GUARD_KEEP_REGRESSION_PROJECTS)
      rmSync(project, { recursive: true, force: true });
    else console.error(`kept regression project: ${project}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Guard regression scenarios passed: ${projects.join(', ')}`);
}
