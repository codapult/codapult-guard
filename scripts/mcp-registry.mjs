import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const packagePath = new URL('../package.json', import.meta.url);
const serverPath = new URL('../server.json', import.meta.url);

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const packageJson = await readJson(packagePath);
const serverJson = await readJson(serverPath);

const expected = {
  name: packageJson.mcpName,
  packageName: packageJson.name,
  version: packageJson.version,
};

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const packageEntry = serverJson.packages?.find(
  (entry) => entry.registryType === 'npm' && entry.identifier === expected.packageName,
);

const validate = () => {
  assert(
    typeof expected.name === 'string' && expected.name.length > 0,
    'package.json must define mcpName',
  );
  assert(
    typeof serverJson.description === 'string' && serverJson.description.length <= 100,
    'server.json description must be at most 100 characters',
  );
  assert(serverJson.name === expected.name, 'server.json name must match package.json mcpName');
  assert(
    serverJson.repository?.url === packageJson.repository.url.replace(/\.git$/, ''),
    'server.json repository URL is out of sync',
  );
  assert(
    serverJson.version === expected.version,
    `server.json version must be ${expected.version}`,
  );
  assert(packageEntry, 'server.json must contain the published npm package');
  assert(
    packageEntry.version === expected.version,
    `server.json npm version must be ${expected.version}`,
  );
  assert(packageEntry.transport?.type === 'stdio', 'Guard must be registered with stdio transport');
  assert(
    expected.name.startsWith('io.github.codapult/'),
    'GitHub-authenticated MCP names must use the codapult namespace',
  );
};

const sync = async () => {
  serverJson.version = expected.version;
  for (const entry of serverJson.packages ?? []) {
    if (entry.registryType === 'npm' && entry.identifier === expected.packageName) {
      entry.version = expected.version;
    }
  }
  await writeFile(serverPath, `${JSON.stringify(serverJson, null, 2)}\n`);
};

const waitForNpmPackage = async () => {
  const timeoutMs = Number(process.env.MCP_NPM_WAIT_TIMEOUT_MS ?? 600_000);
  const intervalMs = Number(process.env.MCP_NPM_WAIT_INTERVAL_MS ?? 30_000);
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0, 'MCP_NPM_WAIT_TIMEOUT_MS must be positive');
  assert(
    Number.isFinite(intervalMs) && intervalMs > 0,
    'MCP_NPM_WAIT_INTERVAL_MS must be positive',
  );
  const packageUrl = `https://registry.npmjs.org/${encodeURIComponent(expected.packageName)}`;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'not found';

  // Initial wait
  await new Promise((resolve) => {
    setTimeout(resolve, intervalMs);
  });

  while (Date.now() < deadline) {
    try {
      const response = await fetch(packageUrl, {
        headers: { accept: 'application/json' },
      });
      if (response.ok) {
        const metadata = await response.json();
        const published = metadata.versions?.[expected.version];
        if (published?.mcpName === expected.name) {
          console.log(
            `npm package ${expected.packageName}@${expected.version} is available with mcpName.`,
          );
          return;
        }
        if (published !== undefined) {
          throw new Error(
            `npm package ${expected.packageName}@${expected.version} has mcpName ${String(published.mcpName)}, expected ${expected.name}.`,
          );
        }
        lastStatus = 'version not found';
      } else {
        lastStatus = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    console.log(
      `Waiting for npm propagation (${lastStatus}); retrying in ${Math.min(intervalMs, remainingMs)}ms.`,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(intervalMs, remainingMs));
    });
  }

  throw new Error(
    `Timed out waiting for ${expected.packageName}@${expected.version} on npm (${lastStatus}).`,
  );
};

const command = process.argv[2] ?? 'validate';

if (command === 'sync') {
  await sync();
  validate();
  console.log(`MCP Registry metadata synchronized to ${expected.version}.`);
} else if (command === 'validate') {
  validate();
  console.log(`MCP Registry metadata is valid for ${expected.packageName}@${expected.version}.`);
} else if (command === 'wait') {
  validate();
  await waitForNpmPackage();
} else {
  throw new Error(`Unknown command: ${command}`);
}
