# Releasing Guard

Guard is distributed through npm as `@codapult/guard`. A GitHub Release is used as the reviewed
release record and triggers publication to npm and, after npm succeeds, the official MCP Registry.
The GitHub Release is not a second package distribution channel.

## Recommended flow

1. Run `pnpm release` from a clean, up-to-date checkout. `release-it` updates the version and
   changelog, creates the matching tag, pushes it, and creates the GitHub Release.
2. The `release.yml` workflow checks out the tag, verifies that the tag and package version match,
   runs the complete release check, validates `server.json`, and publishes the exact package to npm
   with provenance.
3. The workflow waits until the exact npm version is visible and contains the expected `mcpName`.
4. After npm publication succeeds, the workflow authenticates with GitHub OIDC and publishes the
   matching MCP server metadata to the official Registry.

If a release is prepared manually, update `CHANGELOG.md` and `package.json`, run
`pnpm mcp:sync`, run `pnpm release:check`, push a matching tag such as `v0.1.0`, and publish the
GitHub Release for that tag.

The workflow uses npm trusted publishing through GitHub Actions OIDC. Configure the npm package's
trusted publisher for this repository and workflow before the first publication. No npm token is
stored in the repository.

## MCP Registry metadata

`server.json` describes the stdio MCP server exposed by the npm package. Its `name` is
`io.github.codapult/guard` and must match the `mcpName` field in `package.json`; the Registry uses
that marker to verify npm package ownership. The `mcp:validate` script checks the name, repository,
package identifier, transport, and versions locally. `release-it` runs `mcp:sync` after bumping the
package version so the release commit contains matching metadata.

The Registry currently hosts server metadata, not npm artifacts, and is in preview. Therefore the
Registry publication is deliberately a post-npm release step and is not part of ordinary local
development. The release job uses GitHub OIDC; configure the workflow's `id-token: write`
permission and protect the release environment before enabling production publication. The release
workflow pins and verifies the Linux x64 `mcp-publisher` binary; update its version and checksum
deliberately when upgrading the publisher.

If npm publication succeeds but Registry publication fails because npm propagation is delayed,
use the workflow's **Run workflow** action with the failed release tag after the package becomes
visible. The npm step verifies the existing version and continues only when its `mcpName` matches;
it does not attempt to overwrite an npm version.

## Why use both GitHub Release and npm?

They serve different purposes:

- npm is where users install `@codapult/guard`;
- the GitHub Release records the source tag, changelog, release notes, and maintainer decision;
- the published GitHub Release provides one explicit, auditable trigger for npm publication.

A GitHub Release is not technically required to publish to npm. A tag-triggered workflow could
publish directly, but the reviewed-release trigger makes accidental publication less likely and
keeps source, changelog, and npm version aligned.

Do not publish by running `npm publish` manually unless the release workflow is intentionally being
replaced. Never reuse an already-published version.
