import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

rmSync(resolve(root, 'dist'), { recursive: true, force: true });
rmSync(resolve(root, 'tsconfig.tsbuildinfo'), { force: true });
rmSync(resolve(root, 'tsconfig.build.tsbuildinfo'), { force: true });
