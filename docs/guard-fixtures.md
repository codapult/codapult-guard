# Guard fixture matrix

The fixture matrix is a maintainer smoke test for project shapes that are not represented by the
Codapult application itself. Clone the repositories into a sibling workspace directory named
`guard-fixtures/`; the directory is disposable and is never shipped with the CLI.

Current fixtures:

| Shape                               | Fixture                          |
| ----------------------------------- | -------------------------------- |
| Next.js App Router / pnpm workspace | `vercel/next-learn`              |
| Vite + React + TypeScript           | `simerlec/vite-react-ts-starter` |
| Hono Node.js/TypeScript package     | `honojs/node-server`             |
| pnpm monorepo                       | `changesets/changesets`          |
| JavaScript-only package             | `expressjs/express`              |

Run the smoke matrix after building the CLI:

```bash
GUARD_FIXTURES_ROOT=../guard-fixtures pnpm test:guard:fixtures
```

The script initializes only fixtures without a baseline. Existing Guard state is never forcibly
replaced. To run a subset:

```bash
GUARD_SMOKE_PROJECTS=next-learn,changesets pnpm test:guard:fixtures
```

The smoke gate checks that discovery can initialize each project, that all Guard artifacts pass
`doctor`, and that architecture-only `verify` completes without project dependencies being
installed. Dependency installation and the projects' own test/build commands remain separate
checks.

The mutation gate copies representative fixtures, injects a forbidden side-effect import, and
requires Guard to report the new violation:

```bash
pnpm test:guard:fixtures:regression
```

Native project commands are available only through the maintainer harness. They are not part of
Guard and do not run in the normal smoke workflow:

```bash
GUARD_NATIVE_INSTALL=1 pnpm test:guard:fixtures:native
```

Use Node versions supported by each fixture. `GUARD_NATIVE_PROJECTS=changesets,express` limits the
run. The harness preserves upstream manifests; it does not rewrite `engines` to make an unsupported
runtime appear valid.

Discovery also records nested workspace package boundaries in `project.json` under
`project.workspacePackages`. During `verify`, root scripts remain authoritative; checks missing
at the root are run in workspace packages that declare them, without duplicating root orchestration.

For a full local audit after installing fixture dependencies, run the native project commands from
each fixture. The current matrix covers Next.js lint/Prettier, Vite tests, Hono Node/TypeScript tests, and the
full Changesets `check-all` (build, tests, typecheck, lint, Oxfmt). The Hono fixture replaces
the former Node starter because that project had an obsolete `jws`/`buffer-equal-constant-time`
dependency chain incompatible with current Node runtimes.

## Real pull requests

Guard can review a real GitHub PR in an isolated temporary clone. It does not
modify the upstream repository or add fixture files:

```bash
GUARD_PR_REPO=https://github.com/honojs/node-server \
GUARD_PR_NUMBER=148 \
pnpm test:guard:pr
```

The harness fetches the PR head and the repository default branch, initializes
Guard in the temporary checkout, and runs `codapult-guard review --base ...`.
Set `GUARD_PR_BASE` when the PR targets a non-default branch. Use
`GUARD_KEEP_PR_PROJECT=1` to retain the checkout for investigation.
