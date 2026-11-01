import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const projects = [
  {
    name: 'next-learn',
    url: 'https://github.com/vercel/next-learn.git',
    sha: 'bb2558441a6673ab76c89914c25018bffa27a2ba',
  },
  {
    name: 'vite-react-ts-starter',
    url: 'https://github.com/simerlec/vite-react-ts-starter.git',
    sha: '087a2581feaabeb9184515c72b0f7ff2325cd603',
  },
  {
    name: 'node-server',
    url: 'https://github.com/honojs/node-server.git',
    sha: '64dc09e0c37eab30b51d33d61a3a2bae3fdee263',
  },
  {
    name: 'changesets',
    url: 'https://github.com/changesets/changesets.git',
    sha: 'c9269c01af5f3f7463adc648890fc3a8a729dd18',
  },
  {
    name: 'express',
    url: 'https://github.com/expressjs/express.git',
    sha: '9a34acf03cb818ff3f8bc40e44176e277a25cbb9',
  },
];

const root = resolve(process.env.GUARD_FIXTURES_ROOT ?? '../guard-fixtures');

if (!existsSync(root)) {
  mkdirSync(root);
}

for (const { name, url, sha } of projects) {
  const project = join(root, name);

  if (!existsSync(join(project, '.git'))) {
    const result = spawnSync('git', ['clone', '--depth', '1', url, project], {
      stdio: 'pipe',
      timeout: 120_000,
    });
    if (result.status !== 0) {
      rmSync(project, { recursive: true, force: true });
      const stderr = result.stderr.toString().trim() || 'unknown error';
      throw new Error(`git clone failed: ${stderr}`);
    }
  }

  execSync('git fetch --depth=1 origin ' + sha, { cwd: project, stdio: 'pipe', timeout: 120_000 });
  execSync('git checkout --detach ' + sha, { cwd: project, stdio: 'pipe', timeout: 120_000 });
}
