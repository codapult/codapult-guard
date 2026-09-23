import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const scripts = {
  smoke: 'guard-fixture-smoke.mjs',
  regression: 'guard-fixture-regression.mjs',
  adversarial: 'guard-fixture-adversarial.mjs',
  native: 'guard-fixture-native.mjs',
  pr: 'guard-pr-review.mjs',
};

const argument = process.argv.find((value) => value.startsWith('--suite='))?.slice(8);
const all = process.argv.includes('--all');
const strict = process.argv.includes('--strict') || process.env.GUARD_FIXTURE_STRICT === '1';
const requested = argument ?? process.env.GUARD_FIXTURE_SUITES;
const suites = (
  all ? Object.keys(scripts) : (requested?.split(',') ?? ['smoke', 'regression', 'adversarial'])
)
  .map((value) => value.trim())
  .filter(Boolean);
const unknown = suites.filter((suite) => !scripts[suite]);
if (unknown.length > 0) throw new Error(`Unknown fixture suite(s): ${unknown.join(', ')}`);

function unavailable(suite, reason) {
  const result = { suite, status: 'skipped', durationMs: 0, reason };
  if (strict) result.status = 'failed';
  return result;
}

const results = [];
for (const suite of suites) {
  if (suite === 'pr' && (!process.env.GUARD_PR_REPO || !process.env.GUARD_PR_NUMBER)) {
    results.push(unavailable(suite, 'Set GUARD_PR_REPO and GUARD_PR_NUMBER to run a PR review.'));
    continue;
  }
  if (suite === 'native' && process.env.GUARD_NATIVE_INSTALL !== '1') {
    results.push(
      unavailable(
        suite,
        'Native suites are opt-in. Set GUARD_NATIVE_INSTALL=1 to install fixture dependencies.',
      ),
    );
    continue;
  }
  const started = Date.now();
  const script = resolve('scripts', scripts[suite]);
  try {
    execFileSync(process.execPath, [script], {
      cwd: process.cwd(),
      stdio: 'inherit',
      timeout: Number(process.env.GUARD_FIXTURE_TIMEOUT_MS ?? 1_800_000),
      env: process.env,
    });
    results.push({ suite, status: 'passed', durationMs: Date.now() - started });
  } catch (error) {
    results.push({
      suite,
      status: 'failed',
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const summary = {
  status: results.some((result) => result.status === 'failed') ? 'failed' : 'passed',
  suites: results,
};
if (process.argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
else
  console.log(
    `Guard fixture suite: ${summary.status} (${results.map((result) => `${result.suite}:${result.status}`).join(', ')})`,
  );
if (summary.status === 'failed') process.exitCode = 1;
