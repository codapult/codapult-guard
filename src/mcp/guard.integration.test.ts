import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { registerGuardPrompts } from './prompts.js';
import { registerGuardResources } from './resources.js';
import { registerGuardTools } from './tools/guard.js';

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('Guard MCP transport', () => {
  it('exposes Guard tools through the real MCP transport', async () => {
    const server = new McpServer({ name: 'guard-test', version: '1.0.0' });
    registerGuardTools(server);
    registerGuardPrompts(server);
    registerGuardResources(server);
    const client = new Client({ name: 'guard-client-test', version: '1.0.0' });
    clients.push(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      'codapult_guard_context',
      'codapult_guard_propose',
      'codapult_guard_init',
      'codapult_guard_proposal_decide',
      'codapult_guard_verify',
      'codapult_guard_audit',
      'codapult_guard_review',
      'codapult_guard_check',
      'codapult_guard_impact',
      'codapult_guard_explain',
    ]);
    expect(
      tools.tools.find((tool) => tool.name === 'codapult_guard_verify')?.inputSchema,
    ).toBeDefined();
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([
      'codapult_guard_proposal_review',
      'codapult_guard_semantic_review',
    ]);
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.name)).toEqual([
      'codapult_guard_rules',
      'codapult_guard_context',
      'codapult_guard_architecture',
      'codapult_guard_proposals',
    ]);
  });
});
