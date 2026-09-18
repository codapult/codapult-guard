import type { ProjectModel } from '../discovery/discovery.js';

export interface GuardPackDefinition {
  id: string;
  title: string;
  capabilities: string[];
  focus: string[];
}

export interface GuardPackAssessment {
  id: string;
  status: 'observed';
  evidence: string[];
  gaps: string[];
  checks: {
    id: string;
    status: 'observed' | 'missing';
    evidence: string[];
  }[];
}

export const guardPacks: GuardPackDefinition[] = [
  {
    id: 'nextjs',
    title: 'Next.js / React boundaries',
    capabilities: ['nextjs'],
    focus: ['server/client boundaries', 'routes', 'Server Actions'],
  },
  {
    id: 'react',
    title: 'React component boundaries',
    capabilities: ['react'],
    focus: ['component boundaries', 'client state', 'rendering contracts'],
  },
  {
    id: 'api',
    title: 'API boundaries',
    capabilities: ['routing'],
    focus: ['authentication', 'validation', 'rate limiting', 'error contracts'],
  },
  {
    id: 'database',
    title: 'Database and ORM',
    capabilities: ['persistence'],
    focus: ['schema drift', 'migrations', 'repository boundaries'],
  },
  {
    id: 'auth',
    title: 'Authentication and authorization',
    capabilities: ['identity'],
    focus: ['auth entrypoints', 'organization scope', 'authorization ordering'],
  },
  {
    id: 'payments',
    title: 'Payments and billing',
    capabilities: ['payments', 'billing'],
    focus: ['webhook signatures', 'idempotency', 'provider adapters'],
  },
  {
    id: 'jobs',
    title: 'Queues and background jobs',
    capabilities: ['jobs', 'queues'],
    focus: ['retries', 'idempotency', 'dead-letter handling'],
  },
  {
    id: 'ai',
    title: 'AI and RAG',
    capabilities: ['ai', 'rag'],
    focus: ['gateway boundaries', 'organization scope', 'quotas and usage'],
  },
  {
    id: 'security',
    title: 'Security',
    capabilities: ['security'],
    focus: ['secrets', 'SSRF', 'dependency and SAST adapters'],
  },
  {
    id: 'deployment',
    title: 'Deployment and operations',
    capabilities: ['deployment', 'observability'],
    focus: ['environment', 'health checks', 'release safety'],
  },
  {
    id: 'email',
    title: 'Email and notifications',
    capabilities: ['email'],
    focus: ['template boundaries', 'delivery failures', 'retry safety'],
  },
  {
    id: 'storage',
    title: 'File and object storage',
    capabilities: ['storage'],
    focus: ['upload validation', 'access control', 'public/private boundaries'],
  },
  {
    id: 'graphql-rpc',
    title: 'GraphQL and RPC',
    capabilities: ['graphql-rpc'],
    focus: ['input validation', 'authorization', 'error contracts'],
  },
  {
    id: 'i18n',
    title: 'Internationalization',
    capabilities: ['i18n'],
    focus: ['locale boundaries', 'message completeness', 'formatting'],
  },
  {
    id: 'observability',
    title: 'Observability',
    capabilities: ['observability'],
    focus: ['structured logs', 'traces', 'correlation and privacy'],
  },
  {
    id: 'cache',
    title: 'Caching and key-value storage',
    capabilities: ['cache'],
    focus: ['invalidation', 'TTL', 'tenant isolation'],
  },
  {
    id: 'analytics',
    title: 'Product analytics',
    capabilities: ['analytics'],
    focus: ['event contracts', 'privacy', 'identity consistency'],
  },
  {
    id: 'search',
    title: 'Search and indexing',
    capabilities: ['search'],
    focus: ['index consistency', 'query validation', 'tenant isolation'],
  },
  {
    id: 'content',
    title: 'Content and CMS',
    capabilities: ['content'],
    focus: ['content validation', 'draft/publish flow', 'rendering safety'],
  },
];

export function detectGuardPacks(model: ProjectModel): GuardPackDefinition[] {
  const observed = new Set([
    ...Object.keys(model.capabilities),
    ...model.project.frameworks.map((framework) => framework.toLowerCase().replace(/[^a-z]/g, '')),
  ]);
  return guardPacks.filter((pack) =>
    pack.capabilities.some((capability) => observed.has(capability)),
  );
}

export function assessGuardPacks(model: ProjectModel): GuardPackAssessment[] {
  const packageCount = (capability: string): number => {
    const signal: ProjectModel['capabilities'][string] | undefined = Object.hasOwn(
      model.capabilities,
      capability,
    )
      ? model.capabilities[capability]
      : undefined;
    return signal?.packages.length ?? 0;
  };
  return detectGuardPacks(model).map((pack) => {
    const evidence: string[] = [];
    const gaps: string[] = [];
    const checks: GuardPackAssessment['checks'] = [];
    const files = model.files.map((file) => file.path);
    const checkFiles = (
      id: string,
      pattern: RegExp,
      message: string,
      signalPattern: RegExp = pattern,
    ): void => {
      const fileMatches = files.filter((file) => pattern.test(file));
      const moduleMatches = model.modules
        .filter((module) =>
          signalPattern.test(
            [module.path, ...module.imports, ...module.importedSymbols, ...module.calls].join('\n'),
          ),
        )
        .map((module) => module.path);
      const matches = [...new Set([...fileMatches, ...moduleMatches])];
      checks.push({
        id,
        status: matches.length > 0 ? 'observed' : 'missing',
        evidence: matches.slice(0, 5),
      });
      if (matches.length === 0) gaps.push(message);
    };
    switch (pack.id) {
      case 'nextjs':
        evidence.push(`${model.patterns.routeHandlers.length} route handler(s)`);
        checkFiles(
          'server-client-boundary',
          /(?:^|\/)(?:layout|page|component|client|server)\.(?:tsx?|jsx?)$/i,
          'No likely server/client boundary file was detected.',
        );
        if (!model.insights.boundaries.some((boundary) => boundary.kind === 'client')) {
          gaps.push('No client/server boundary markers were observed.');
        }
        break;
      case 'api':
        evidence.push(`${model.patterns.routeHandlers.length} route handler(s)`);
        checkFiles(
          'input-validation',
          /(?:schema|validation|validate|parse|zod|valibot|joi|yup)/i,
          'No input-validation boundary was detected by file naming.',
        );
        if (packageCount('security') === 0) {
          gaps.push('No explicit validation/security dependency was observed.');
        }
        break;
      case 'database':
        evidence.push(`${model.schemas.length} schema file(s)`);
        checkFiles(
          'migration-path',
          /(?:^|\/)(?:migrations?|drizzle|prisma)\b/i,
          'No schema migration path was detected by file naming.',
        );
        if (model.schemas.length === 0) gaps.push('No schema files were detected.');
        break;
      case 'auth':
        evidence.push(`${packageCount('identity')} identity package(s)`);
        checkFiles(
          'authorization-boundary',
          /(?:auth|authentication|identity|session|permission|policy)/i,
          'No authentication or authorization boundary was detected.',
          /auth|authentication|identity|session|permission|policy|requireUser|requireOrganization|authorize/i,
        );
        checkFiles(
          'tenant-scope',
          /(?:tenant|organization|workspace|team|scope)/i,
          'No tenant, organization, workspace, or scope signal was detected.',
          /tenant|organization|workspace|team|scope|orgId|tenantId/i,
        );
        break;
      case 'payments':
        evidence.push(`${packageCount('payments')} provider package(s)`);
        checkFiles(
          'webhook-receiver',
          /webhook|event/i,
          'No webhook or event receiver file was detected.',
        );
        checkFiles(
          'signature-verification',
          /(?:signature|verify|constructEvent|webhook)/i,
          'No payment signature-verification signal was detected by file naming.',
        );
        checkFiles(
          'idempotency',
          /idempot|dedup|event[-_]?log/i,
          'No payment idempotency signal was detected by file naming.',
        );
        break;
      case 'jobs':
        evidence.push(`${packageCount('jobs')} queue package(s)`);
        checkFiles(
          'worker-boundary',
          /worker|queue|job|task/i,
          'No queue or worker implementation file was detected.',
        );
        checkFiles(
          'retry-policy',
          /retry|backoff|attempt/i,
          'No retry/backoff signal was detected by file naming.',
        );
        checkFiles(
          'idempotency',
          /idempot|dedup|job[-_]?key/i,
          'No job idempotency signal was detected by file naming.',
        );
        break;
      case 'ai':
        evidence.push(`${packageCount('ai')} AI package(s)`);
        checkFiles(
          'usage-boundary',
          /guardrail|quota|usage|meter|limit/i,
          'No usage, quota, or guardrail boundary was detected.',
        );
        break;
      case 'security':
        evidence.push(`${packageCount('security')} security package(s)`);
        checkFiles(
          'security-test-coverage',
          /(?:security|auth|permission|policy|csrf|xss).*\.(?:test|spec)\./i,
          'No security-focused test file was detected by file naming.',
        );
        if (model.tests.files.length === 0)
          gaps.push('No tests were detected for security-sensitive code.');
        break;
      case 'deployment':
        evidence.push(`${packageCount('deployment')} deployment package(s)`);
        checkFiles(
          'operational-health',
          /health|readiness|liveness|workflow|docker/i,
          'No health check, workflow, or container definition was detected.',
        );
        break;
      case 'email':
        evidence.push(`${packageCount('email')} email provider package(s)`);
        checkFiles(
          'template-boundary',
          /email|mail|template/i,
          'No email template or delivery boundary was detected.',
        );
        checkFiles(
          'delivery-retry',
          /retry|queue|job|outbox/i,
          'No email retry or outbox signal was detected by file naming.',
        );
        break;
      case 'storage':
        evidence.push(`${packageCount('storage')} storage package(s)`);
        checkFiles(
          'upload-boundary',
          /upload|storage|media|asset/i,
          'No upload or storage boundary was detected.',
        );
        checkFiles(
          'access-control',
          /permission|policy|access|private|signed/i,
          'No storage access-control signal was detected by file naming.',
        );
        break;
      case 'graphql-rpc':
        evidence.push(`${packageCount('graphql-rpc')} GraphQL/RPC package(s)`);
        checkFiles(
          'schema-boundary',
          /schema|resolver|procedure|rpc/i,
          'No API schema or resolver boundary was detected.',
        );
        checkFiles(
          'input-validation',
          /schema|validation|validate|parse|zod|valibot|joi|yup/i,
          'No GraphQL/RPC input-validation signal was detected.',
        );
        break;
      case 'i18n':
        evidence.push(`${packageCount('i18n')} i18n package(s)`);
        checkFiles(
          'message-catalog',
          /locale|locales|messages|translation|i18n/i,
          'No message catalog or locale boundary was detected.',
        );
        break;
      case 'observability':
        evidence.push(`${packageCount('observability')} observability package(s)`);
        checkFiles(
          'structured-logging',
          /log|logger|logging|telemetry|observability/i,
          'No logging or telemetry boundary was detected.',
        );
        checkFiles(
          'correlation',
          /request[-_]?id|correlation|trace|span/i,
          'No request correlation or tracing signal was detected.',
        );
        break;
      case 'cache':
        evidence.push(`${packageCount('cache')} cache package(s)`);
        checkFiles('cache-boundary', /cache|redis/i, 'No cache boundary was detected.');
        checkFiles(
          'invalidation-ttl',
          /invalidate|invalidation|ttl|expire/i,
          'No cache invalidation or TTL signal was detected.',
        );
        break;
      case 'analytics':
        evidence.push(`${packageCount('analytics')} analytics package(s)`);
        checkFiles(
          'event-boundary',
          /analytics|tracking|event/i,
          'No analytics event boundary was detected.',
        );
        checkFiles(
          'privacy-consent',
          /consent|privacy|opt[-_]?out|anonymous/i,
          'No analytics privacy or consent signal was detected.',
        );
        break;
      case 'search':
        evidence.push(`${packageCount('search')} search package(s)`);
        checkFiles(
          'index-boundary',
          /search|index|indexing/i,
          'No search index boundary was detected.',
        );
        checkFiles(
          'reindex-path',
          /reindex|sync|synchroni|ingest/i,
          'No search reindex or synchronization signal was detected.',
        );
        break;
      case 'content':
        evidence.push(`${packageCount('content')} content package(s)`);
        checkFiles(
          'content-boundary',
          /content|cms|post|article|mdx/i,
          'No content or CMS boundary was detected.',
        );
        checkFiles(
          'publish-flow',
          /publish|draft|preview|moderation/i,
          'No content draft/publish or moderation signal was detected.',
        );
        break;
      default:
        break;
    }
    return { id: pack.id, status: 'observed', evidence, gaps, checks };
  });
}
