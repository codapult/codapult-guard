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

const command = process.argv[2] ?? 'validate';

if (command === 'sync') {
  await sync();
  validate();
  console.log(`MCP Registry metadata synchronized to ${expected.version}.`);
} else if (command === 'validate') {
  validate();
  console.log(`MCP Registry metadata is valid for ${expected.packageName}@${expected.version}.`);
} else {
  throw new Error(`Unknown command: ${command}`);
}
