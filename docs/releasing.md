# Releasing Guard

Guard is distributed through npm as `@codapult/guard`. A GitHub Release is used as the reviewed release record and as
the trigger for the npm publication workflow; it is not a second package distribution channel.

## Recommended flow

1. Run `pnpm release` from a clean, up-to-date checkout. `release-it` updates the version and
   changelog, creates the matching tag, pushes it, and creates the GitHub Release.
2. The `release.yml` workflow checks out the tag, verifies that the tag and package version match,
   runs the complete release check, and publishes the exact package to npm with provenance.

If a release is prepared manually, update `CHANGELOG.md` and `package.json`, run
`pnpm release:check`, push a matching tag such as `v0.1.0`, and publish the GitHub Release for
that tag.

The workflow uses npm trusted publishing through GitHub Actions OIDC. Configure the npm package's
trusted publisher for this repository and workflow before the first publication. No npm token is
stored in the repository.

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
