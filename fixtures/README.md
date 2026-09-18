# Guard fixtures

These small projects exercise the structural cases that are easy to miss in a
real repository. They are intentionally dependency-free and are not included
in the published package.

| Fixture           | Case                                                 |
| ----------------- | ---------------------------------------------------- |
| `aliases`         | TypeScript path aliases and client/server boundaries |
| `re-exports`      | barrel files and aliased exports                     |
| `dynamic-imports` | literal dynamic imports and `require`                |
| `symlinks`        | links must not escape the project root               |
| `deleted-renamed` | Git state with deleted and renamed files             |
| `monorepo`        | nested workspace package boundaries                  |

The executable matrix in `scripts/` also runs against pinned external
repositories. These fixtures keep deterministic adversarial cases local and
fast, so a regression does not depend on GitHub availability.
