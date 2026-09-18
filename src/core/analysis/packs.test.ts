import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverProject } from '../discovery/discovery.js';
import { assessGuardPacks, detectGuardPacks } from './packs.js';

const roots: string[] = [];

function createProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'guard-packs-project-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Guard domain packs', () => {
  it('detects packs from observed frameworks and capabilities', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-packs-'));
    roots.push(root);
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { next: '^1', stripe: '^1', zod: '^1' } }),
    );
    writeFileSync(join(root, 'app/route.ts'), 'export function GET() { return new Response(); }\n');
    writeFileSync(
      join(root, 'app/client.tsx'),
      `'use client';\nexport function Client() { return null; }\n`,
    );

    const model = discoverProject(root);
    const packs = detectGuardPacks(model).map((pack) => pack.id);
    const assessments = assessGuardPacks(model);

    expect(packs).toEqual(expect.arrayContaining(['nextjs', 'api', 'payments']));
    const payments = assessments.find((assessment) => assessment.id === 'payments');
    expect(payments?.status).toBe('observed');
    expect(payments?.gaps).toContain('No webhook or event receiver file was detected.');
    expect(payments?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'webhook-receiver', status: 'missing' }),
        expect.objectContaining({ id: 'idempotency', status: 'missing' }),
      ]),
    );
  });

  it('does not infer Next.js or AI from generic React and email signals', () => {
    const root = createProject({
      'package.json': JSON.stringify({
        dependencies: { react: '^1', 'react-dom': '^1' },
      }),
      'src/App.tsx': `export function App() { return null; }\n`,
      'src/email.ts': `export function sendEmail() {}\n`,
    });

    const packs = detectGuardPacks(discoverProject(root)).map((pack) => pack.id);

    expect(packs).toContain('react');
    expect(packs).not.toContain('nextjs');
    expect(packs).not.toContain('ai');
  });

  it('assesses the wider JS/TS application surface without enabling rules', () => {
    const root = createProject({
      'package.json': JSON.stringify({
        dependencies: {
          resend: '^1',
          redis: '^1',
          graphql: '^1',
          'next-intl': '^1',
          posthog: '^1',
          algoliasearch: '^1',
          mdx: '^1',
        },
      }),
      'src/email/template.ts': 'export const template = true;\n',
      'src/cache/invalidate.ts': 'export const invalidate = true;\n',
      'src/graphql/resolver.ts': 'export const resolver = true;\n',
      'src/locales/en.ts': 'export const messages = {};\n',
      'src/analytics/consent.ts': 'export const consent = true;\n',
      'src/search/reindex.ts': 'export const reindex = true;\n',
      'src/content/publish.ts': 'export const publish = true;\n',
    });

    const assessments = assessGuardPacks(discoverProject(root));
    expect(assessments.map((assessment) => assessment.id)).toEqual(
      expect.arrayContaining([
        'email',
        'cache',
        'graphql-rpc',
        'i18n',
        'analytics',
        'search',
        'content',
      ]),
    );
    expect(assessments.find((assessment) => assessment.id === 'cache')?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'invalidation-ttl', status: 'observed' }),
      ]),
    );
  });

  it('uses AST import and call signals for auth boundaries', () => {
    const root = createProject({
      'package.json': JSON.stringify({ dependencies: { 'next-auth': '^1' } }),
      'app/route.ts': `import { requireUser } from '../lib/auth';\nexport async function GET() { return Response.json(await requireUser()); }\n`,
      'lib/auth.ts': `export function requireUser() { return { id: 'user' }; }\n`,
    });

    const auth = assessGuardPacks(discoverProject(root)).find(
      (assessment) => assessment.id === 'auth',
    );

    expect(auth?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'authorization-boundary', status: 'observed' }),
      ]),
    );
  });
});
