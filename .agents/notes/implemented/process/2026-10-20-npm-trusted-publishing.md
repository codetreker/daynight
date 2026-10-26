# Agent Note: npm Trusted Publishing

Status: implemented

## Problem

Publishing the CLI requires repeatable package validation and a durable mapping
from an npm version to its source commit. A release tag must identify a package
that is available from the public registry. npm can accept a publication before
its public registry metadata or tarball becomes visible, and metadata can appear
before the corresponding tarball is downloadable. Repeated publication must succeed without replacing an existing version or
moving a tag, and registry verification must allow that processing time without
waiting forever.
Maintainers also need CI publication without storing a long-lived npm token and
must be able to identify the target version in the publishing job's title.

## Decision

The manual [`publish` workflow](../../../../.github/workflows/publish.yml)
accepts only `refs/heads/main` and captures `GITHUB_SHA` as the release source.
The release group allows one active run and does not cancel it when another run
is dispatched.
The version gate chosen in the
[toolchain decision](../../archived/process/2026-10-16-typescript-cli-toolchain.md) remains independent: the reviewed change selects the package version, and publication
neither increments it nor commits changes. Prerelease versions fail because this
workflow publishes stable releases to `latest`. A previously unpublished version
must have greater precedence than the registry's current stable `latest` version.

After the [version preflight](2026-10-22-npm-cli-publication-checks.md) admits
a new release, a read-only preparation job uses Node.js 24 and pnpm 11.28.6 for a
frozen install, CLI type checking, tests and installed acceptance at the captured
commit. The [CLI publication-validation decision](2026-10-22-cli-publication-validation.md)
replaces the original whole-main-checks prerequisite with this independent CLI
validation. It packs the staged CLI
with the captured commit in `gitHead`, smoke-installs the resulting tarball, and
uploads `.tmp/npm-release/artifact/package.tgz` together with `release.json` as
an immutable Actions artifact. The receipt binds package name, version, source,
tag and SHA-512 integrity to the tarball. Preparation exposes the receipt's
version as a job output; the dependent publishing job uses it in the title
`Publish daynight v<version>`. This identifies the validated artifact without
adding a manual version input or another version source.
Publishing a tarball does not infer
`gitHead` from the checkout, so the staged manifest supplies it explicitly;
the [npm publish implementation](https://github.com/npm/cli/blob/ae98c62586b6fea44114f72e249e246a2981de70/lib/commands/publish.js)
distinguishes tarball and directory publication.

Every publishing-job attempt, including a retry, repeats existence-only
preflight before downloading the artifact on a GitHub-hosted Ubuntu runner
with Node.js 24 and npm 12.2.0 for metadata queries. Existing versions or tags
succeed as skips. The job installs pnpm 11.28.6 separately for upload under the
[pnpm OIDC decision](2026-10-22-pnpm-oidc-publication.md), which replaces the
original npm CLI upload path. The job receives `id-token: write` for npm OIDC and
`contents: write` for the final tag. It publishes the same tarball to the public
npm registry with `latest` and provenance enabled and lifecycle scripts disabled. No npm token
is provided. The package repository metadata identifies the GitHub source and
CLI subdirectory, as required for source attribution.

The npm package's trusted publisher identifies GitHub owner `codetreker`,
repository `daynight`, workflow filename `publish.yml`, and no environment.
It must allow direct `npm publish`; the always-allowed staged action does not
grant that permission. A package owner configures this connection on npmjs.
The first successful publication must validate a newly created connection within
two days, after which npm binds it to the repository's immutable identity.
The [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers)
owns these registry requirements; the [provenance documentation](https://docs.npmjs.com/generating-provenance-statements)
owns source and build attestation requirements.

For a new upload, publication completion is determined through the public
registry. The release requires the registry's `gitHead` and SHA-512 integrity
to match the receipt, downloads the registered tarball, and verifies its bytes.
Only then does it create the lightweight `daynight-v<version>` tag at the
captured source commit. The prefix distinguishes CLI releases from the
independent server. Existing refs are never rewritten. Existing tags or npm
versions detected before upload succeed without verification or tag completion,
regardless of their source or contents. A failed upload also succeeds when a
subsequent exact npm query confirms that the version exists.

Public verification of a fresh upload uses one loop and one ten-minute deadline
for metadata and tarball visibility, starting after npm accepts publication.
Metadata is read through `npm view`; npm JSON `E404` or a tarball HTTP 404 means
propagation is pending. Validated metadata is retained while waiting for the
tarball, without resetting the deadline or republishing. Each poll logs its
attempt number, elapsed time and remaining time. Other errors, malformed
metadata or tarball URLs, source mismatches and integrity mismatches fail.
npm queries have a 30-second process limit; GitHub and tarball HTTP requests,
including response bodies, retain a 20-second limit. Verification operations
share the remaining overall deadline. Tag creation follows successful public
byte verification. The publishing job has a 15-minute limit for setup,
publication, visibility verification and tagging; ordinary CI validation limits
remain independent.

The original policy verified source and artifact identity for all existing
versions and could finish a missing tag from a retained artifact. The
[version-preflight decision](2026-10-21-publication-version-preflight.md) first
replaced admission for new dispatches while retaining strict same-run recovery.
The [npm CLI publication-check decision](2026-10-22-npm-cli-publication-checks.md)
now applies existence-only skips to every retry as well. It owns npm queries,
uniform skips and duplicate-upload reconciliation. Re-running failed jobs can
succeed once the exact version exists, but does not create its missing tag or
claim that the existing bytes match the artifact. Preparation artifacts remain
available for 30 days.

## Alternatives

**Require a version input for the Actions run-list title.** GitHub evaluates
`run-name` before jobs execute and its
[context availability rules](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability)
do not permit step or job outputs there. An input would enable a versioned run
title but add a manual assertion to each dispatch. The publishing job title
meets the visibility requirement while retaining the existing invocation.

**Create a version tag before publishing.** This supplies a tag trigger but
leaves a release marker when authentication, validation or npm publication
fails. A tag created only after registry verification preserves the meaning of
an available release.

**Store an npm publishing token in GitHub secrets.** This allows unattended
publication but requires secret storage, rotation and token-access management.
OIDC meets the requested publishing mechanism and limits registry credentials to
the configured GitHub workflow.

**Publish on every main merge.** This makes each merge a release authorization,
including documentation-only changes whose package version is unchanged. A
manual dispatch keeps publication intent separate from integration while
validating the CLI at the exact release commit.

**Retain a two-minute public visibility limit.** This ends a failed release
sooner, but the first live publication required longer registry processing after
npm accepted it. A shared ten-minute deadline permits that processing while
bounding the complete polling period, even when individual requests are slow.

**Stop visibility polling when metadata appears.** Metadata supplies the source
and integrity assertion, but the tarball can still return 404 at that point.
Downloading it only once rejects a normally propagating release. A common
deadline covers both resources while retaining a bounded verification period.

## Consequences

The release uses one validated tarball across preparation, installation,
publication and public-registry verification. The privileged publishing job
does not rebuild the package or execute package lifecycle scripts. Tagging is
ordered after an observable successful new publication. Repeated attempts skip
existing releases without mutating package versions or existing tags.
The publishing job title follows the artifact version automatically, including
when failed jobs are re-run with the retained artifact.

The first live publication validated the OIDC path and the original
interrupted-run recovery policy. At source `39bdff4bdc6e271cc69a733ecde742cc004dfdf8`,
[`0.2.3` attempt 1](https://github.com/codetreker/daynight/actions/runs/39365670125/attempts/1)
reported npm acceptance at `2026-10-20T03:46:24.465Z` and warned that processing
could take a few minutes. Its two-minute visibility limit expired at
`03:48:28Z`; the [public registry's publication time](https://registry.npmjs.org/@codetreker%2Fdaynight)
for `0.2.3` is `2026-10-20T03:48:30.613Z`, approximately 126 seconds after
acceptance. The original budget therefore rejected a normally processing
publication. [Attempt 2](https://github.com/codetreker/daynight/actions/runs/39365670125/attempts/2)
verified the existing version against the same source and artifact and created
`daynight-v0.2.3` without republishing. A longer visibility budget keeps this
processing delay inside the release workflow; exhausted or failed verification
still prevents tag creation. The current uniform skip policy does not repeat
that historical tag-completion procedure.

The [`0.6.1` publication](https://github.com/codetreker/daynight/actions/runs/39430284042/job/118656438389)
exposed the separate tarball visibility window. npm accepted it at
`2026-10-20T13:32:27.899Z`; its public metadata records publication at
`13:34:07.035Z`, but the job's tarball request returned 404 at `13:34:08.538Z`.
The public tarball subsequently matched the retained artifact byte for byte,
including its SHA-512 integrity and source
`64b69a3ab864f99f6914b9217dbfbebde60345aa`. Waiting for both resources under the
same deadline handles that propagation order without relaxing artifact identity.

npmjs trusted-publisher configuration is an external prerequisite, and GitHub
repository rules must permit the workflow token to create the release tag. A
successful local check cannot establish either external permission. Expired
publisher configuration and repository permission failures require their owner
to correct the configuration before the same run can complete. The
[README publication instructions](../../../../README.md#npm-publication)
own maintainer setup and invocation.
