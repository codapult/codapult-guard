import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve(process.env.GUARD_CLI ?? 'dist/cli/index.js');
const writers = Number(process.env.GUARD_CONCURRENT_WRITERS ?? 8);
if (!Number.isInteger(writers) || writers < 2)
  throw new Error('GUARD_CONCURRENT_WRITERS must be at least 2.');

const root = mkdtempSync(join(tmpdir(), 'codapult-guard-concurrent-'));
try {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'guard-concurrent-fixture', private: true }),
  );
  writeFileSync(join(root, 'src/index.ts'), 'export const value = true;\n');
  const init = spawn(process.execPath, [cli, 'init'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const initCode = await new Promise((resolveCode) => {
    init.on('close', (code) => resolveCode(code));
  });
  if (initCode !== 0) throw new Error('fixture initialization failed');

  const results = await Promise.all(
    Array.from(
      { length: writers },
      () =>
        new Promise((resolveResult) => {
          const child = spawn(process.execPath, [cli, 'analyze'], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
          });
          let stderr = '';
          child.stderr.on('data', (chunk) => {
            stderr += chunk;
          });
          child.on('close', (code) => resolveResult({ code, stderr: stderr.trim() }));
        }),
    ),
  );
  const artifacts = ['project.json', 'architecture.json', 'conventions.json'];
  for (const artifact of artifacts) {
    const path = join(root, '.codapult/guard', artifact);
    if (!existsSync(path)) throw new Error(`missing artifact after concurrent writes: ${artifact}`);
    JSON.parse(readFileSync(path, 'utf8'));
  }
  const unexpected = results.filter(
    (result) => result.code !== 0 && !result.stderr.toLowerCase().includes('busy'),
  );
  if (unexpected.length > 0)
    throw new Error(`unexpected concurrent writer failure: ${JSON.stringify(unexpected)}`);
  console.log(
    JSON.stringify(
      {
        writers,
        passed: results.filter((result) => result.code === 0).length,
        busy: results.filter((result) => result.code !== 0).length,
      },
      null,
      2,
    ),
  );
} finally {
  if (!process.env.GUARD_KEEP_CONCURRENT_PROJECT) rmSync(root, { recursive: true, force: true });
  else console.error(`kept concurrent project: ${root}`);
}
