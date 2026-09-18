import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerGuardTools } from './tools/guard.js';
import { registerGuardPrompts } from './prompts.js';
import { registerGuardResources } from './resources.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version: string };

const server = new McpServer({
  name: 'codapult-guard',
  version: packageJson.version,
});

registerGuardTools(server);
registerGuardPrompts(server);
registerGuardResources(server);

const transport = new StdioServerTransport();
await server.connect(transport);
