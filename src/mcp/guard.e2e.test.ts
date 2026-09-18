import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeGuard, writeGuardConfig } from '../core/guard.js';
import { registerGuardTools } from './tools/guard.js';

const clients: Client[] = [];
const roots: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function parseText(result: unknown): unknown {
  if (result === null || typeof result !== 'object') {
    throw new Error('MCP tool returned an invalid result');
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error('MCP tool did not return content');
  const first: unknown = content[0];
  if (
    first === null ||
    typeof first !== 'object' ||
    (first as { type?: unknown }).type !== 'text' ||
    typeof (first as { text?: unknown }).text !== 'string'
  ) {
    throw new Error('MCP tool did not return text content');
  }
  return JSON.parse((first as { text: string }).text) as unknown;
}

describe('Guard MCP end-to-end operations', () => {
  it('executes context, proposals, review, and verification through transport', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-mcp-e2e-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mcp-fixture' }));
    writeFileSync(join(root, 'src/index.ts'), 'export const value = 1;\n');
    process.chdir(root);
    initializeGuard(root);

    const server = new McpServer({ name: 'guard-e2e', version: '1.0.0' });
    registerGuardTools(server);
    const client = new Client({ name: 'guard-e2e-client', version: '1.0.0' });
    clients.push(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const proposalResult = await client.callTool({
      name: 'codapult_guard_propose',
      arguments: { persist: true, confirm: true },
    });
    expect(parseText(proposalResult)).toMatchObject({ persisted: true, version: 1 });

    const contextResult = await client.callTool({
      name: 'codapult_guard_context',
      arguments: { refresh: false },
    });
    expect(parseText(contextResult)).toMatchObject({ configured: true, project: { version: 1 } });

    const reviewResult = await client.callTool({
      name: 'codapult_guard_review',
      arguments: { changed_only: true },
    });
    expect(parseText(reviewResult)).toMatchObject({
      version: 1,
      status: 'fail',
      outcome: 'fail',
      deterministicFindings: [],
    });

    const invalidBaseResult = await client.callTool({
      name: 'codapult_guard_review',
      arguments: { changed_only: true, base: 'missing-base-ref' },
    });
    expect(invalidBaseResult.isError).toBe(true);
    const invalidPacket = parseText(invalidBaseResult);
    expect(invalidPacket).toMatchObject({ status: 'fail' });
    expect((invalidPacket as { diffError?: unknown }).diffError).toEqual(
      expect.stringContaining('missing-base-ref'),
    );

    const verifyResult = await client.callTool({
      name: 'codapult_guard_verify',
      arguments: { project_checks: false },
    });
    expect(parseText(verifyResult)).toMatchObject({
      status: 'ok',
      outcome: 'pass',
      architecture: { findings: [] },
    });
  });

  it('supports repeated review and verify calls after an agent repair', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-mcp-loop-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mcp-loop-fixture' }));
    writeFileSync(join(root, 'src/db.ts'), 'export const db = {};\n');
    writeFileSync(
      join(root, 'src/client.ts'),
      `'use client';\nimport { db } from './db';\nexport { db };\n`,
    );
    process.chdir(root);
    initializeGuard(root);
    writeGuardConfig(root, {
      version: 1,
      contracts: [],
      rules: [
        {
          id: 'client-boundary',
          description: 'Client code must not import persistence.',
          severity: 'error',
          kind: 'client-forbidden-import',
          patterns: ['./db'],
          status: 'active',
        },
      ],
    });

    const server = new McpServer({ name: 'guard-loop', version: '1.0.0' });
    registerGuardTools(server);
    const client = new Client({ name: 'guard-loop-client', version: '1.0.0' });
    clients.push(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const failed = await client.callTool({
      name: 'codapult_guard_verify',
      arguments: { project_checks: false },
    });
    expect(parseText(failed)).toMatchObject({
      status: 'fail',
      architecture: { findings: [expect.objectContaining({ ruleId: 'client-boundary' })] },
    });

    writeFileSync(join(root, 'src/client.ts'), `'use client';\nexport const value = 1;\n`);
    const repaired = await client.callTool({
      name: 'codapult_guard_verify',
      arguments: { project_checks: false },
    });
    expect(parseText(repaired)).toMatchObject({ status: 'ok', architecture: { findings: [] } });
  });
});
