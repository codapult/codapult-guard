import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

rmSync(resolve(fileURLToPath(new URL('..', import.meta.url)), 'dist'), {
  recursive: true,
  force: true,
});
