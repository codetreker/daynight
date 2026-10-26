# Agent Note: npm CLI Publication Checks

Status: implemented

## Problem

Publication preflight can fail while checking an unpublished version, before
validation or upload begins. Direct requests to the npm package/version endpoint
can time out even when the package document is available. Separately, treating
an existing version as a source or artifact conflict makes repeated publication
fail despite the requested version already being available. The same version
must have the same successful skip result on dispatches and retries.

## Decision

The [publication script](../../../../packages/daynight/scripts/publish.ts)
uses `npm view <package>@<version> --json --registry=https://registry.npmjs.org`
for exact versions, `latest`, and metadata visibility after a fresh upload.
It adopts the npm CLI query and JSON error handling used by
[Borgee's publication checker](https://github.com/gim-home/borgee/blob/37b8fa8ba74408f4b0837ac6b2c0b16a3a972f52/scripts/check-npm-publication.mjs).
Successful object and singleton-array results are normalized and validated.
Only an npm JSON `E404` result means absence. Authentication, transport, timeout,
invalid JSON and invalid metadata failures remain visible with the failing
package query identified. Query processes have a 30-second limit and use a
project-local cache. The workflow uses pinned npm 12.2.0 for these queries.

The npm CLI reads the complete package document and selects the requested
version locally, as shown in its
[version selection](https://github.com/npm/cli/blob/c276cadf785c1018d82dd287fe7742567055efb9/lib/commands/view.js#L130-L195)
and [registry URL construction](https://github.com/npm/cli/blob/c276cadf785c1018d82dd287fe7742567055efb9/node_modules/pacote/lib/registry.js#L35-L36).
This avoids relying on the direct package/version endpoint for an absent
version and delegates registry transport to the installed npm CLI.

An exact `daynight-v<version>` tag or exact npm version produces a successful
skip on every dispatch and retry, before preparing or uploading a package.
The publishing job always repeats this preflight. The script also checks before
uploading, covering a version that appears after the workflow preflight. Existing
versions are accepted regardless of source SHA or tarball contents. A skip
does not download or verify the existing package, move a tag or create a missing
tag. Preparation attempts no longer select a different recovery path.

If upload fails, the script checks the exact npm version again. A
confirmed existing version converts the duplicate-publication race into a
successful skip. Confirmed absence preserves the original publication error;
an unsuccessful lookup remains a failure and preserves its cause. A failed
upload alone never proves that the version exists.

New uploads retain the source-bound tarball, OIDC, stable-version precedence,
ten-minute public metadata/tarball visibility deadline and post-verification
immutable tagging chosen in the
[trusted-publishing decision](../../archived/process/2026-10-20-npm-trusted-publishing.md). This decision
replaces the direct HTTP lookup and strict existing-version recovery in the
[preflight decision](../../archived/process/2026-10-21-publication-version-preflight.md). It does not
change package contents or the manual main-only release trigger.
The [pnpm OIDC decision](2026-10-22-pnpm-oidc-publication.md) replaces the upload
client with pnpm 11.28.6 while retaining npm 12.2.0 for these metadata queries
and preserving the existence and duplicate-publication rules.

## Alternatives

**Extend the direct HTTP lookup timeout or add custom retries.** The observed
absent-version endpoint stalled while `npm view` returned `E404` promptly.
Longer waits preserve that endpoint dependency and duplicate npm's registry
transport behavior.

**Keep source and artifact comparisons for existing versions.** This permits
completing a missing tag from a retained artifact, but turns a harmless repeated
publication into a failure when main or the artifact has changed. Uniform
existence-only skips deliberately give up automatic tag completion.

**Treat every failed npm query as absence.** This can proceed to publication
after authentication or network failure. Borgee's JSON `E404` handling provides
the required existence result while exposing other failures.

## Consequences

The version lookup uses the same npm CLI mechanism across admission, precedence
checks and fresh-publication verification. Existing versions and tags succeed
without source or byte comparisons, including retries and confirmed duplicate
uploads. Missing tags remain missing when the package is skipped.

Fresh-upload verification can still fail if the uploaded package cannot be
verified within its deadline. A later attempt skips once the exact version is
visible; it makes no new byte-verification or tag-completion claim. Lookup errors
continue to fail because they cannot establish either presence or absence.
