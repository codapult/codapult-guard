import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { discoverProjectWithMetrics } from '../dist/index.js';

const files = Number(process.env.GUARD_BENCH_FILES ?? 1000);
const runs = Number(process.env.GUARD_BENCH_RUNS ?? 3);
const maxMs = Number(process.env.GUARD_BENCH_MAX_MS ?? 0);
if (!Number.isInteger(files) || files < 1)
  throw new Error('GUARD_BENCH_FILES must be a positive integer.');
if (!Number.isInteger(runs) || runs < 1)
  throw new Error('GUARD_BENCH_RUNS must be a positive integer.');

const root = mkdtempSync(join(tmpdir(), 'codapult-guard-benchmark-'));
try {
  mkdirSync(join(root, 'packages'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'guard-benchmark', private: true, workspaces: ['packages/*'] }),
  );
  for (let index = 0; index < files; index += 1) {
    const packageRoot = join(root, 'packages', `package-${String(index).padStart(4, '0')}`);
    mkdirSync(join(packageRoot, 'src'), { recursive: true });
    const next =
      index + 1 < files
        ? `import { value as next } from '../package-${String(index + 1).padStart(4, '0')}/src/index.js';\n`
        : '';
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: `@bench/package-${index}`, private: true }),
    );
    writeFileSync(
      join(packageRoot, 'src/index.ts'),
      `${next}export const value = ${index}${next ? ' + next' : ''};\n`,
    );
  }
  const timings = [];
  let last;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    const discovery = discoverProjectWithMetrics(root, { persistCache: true });
    const durationMs = Math.round((performance.now() - started) * 100) / 100;
    timings.push({ run: run + 1, durationMs, ...discovery.metrics });
    last = discovery;
  }
  const result = {
    files,
    runs,
    timings,
    coldMs: timings[0].durationMs,
    warmAverageMs:
      timings.slice(1).reduce((sum, item) => sum + item.durationMs, 0) /
      Math.max(1, timings.length - 1),
    discoveredFiles: last.model.files.length,
    discoveredModules: last.model.modules.length,
  };
  console.log(JSON.stringify(result, null, 2));
  if (maxMs > 0 && result.coldMs > maxMs) {
    console.error(`Guard benchmark exceeded GUARD_BENCH_MAX_MS=${maxMs}.`);
    process.exitCode = 1;
  }
} finally {
  if (!process.env.GUARD_KEEP_BENCHMARK_PROJECT) rmSync(root, { recursive: true, force: true });
  else console.error(`kept benchmark project: ${root}`);
}
