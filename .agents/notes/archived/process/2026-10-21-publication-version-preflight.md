# Agent Note: Publication Version Preflight

Status: implemented

## Problem

A manual publication of an unchanged package version performs the complete
validation workload before discovering an existing npm version or release tag.
When main has advanced since publication, comparing the existing source with
the dispatch source rejects the run even though the requested version already
exists. Maintainers need a successful early skip for that case.

## Decision

The manual [publication workflow](../../../../.github/workflows/publish.yml)
checks the exact `daynight-v<version>` tag and npm version before installing
dependencies, validating the CLI or preparing an artifact. Either marker
produces an explicit successful skip regardless of its source or contents.
Tag presence short-circuits the npm lookup. A skip reports existence and does
not verify the existing package or create a missing tag.

The original preflight decision distinguished new dispatches from failed
publishing-job retries. Preparation exposed its Actions attempt alongside the
artifact version; a matching attempt identified the artifact's first use.
First use repeated preflight before downloading the artifact and installing
npm. A failed publishing-job retry reused the successful preparation output,
bypassed preflight, and verified the existing source and artifact before
completing its missing tag. Comparing attempts also distinguished a first
publication after failed preparation from a publication retry.

That distinction retained the earlier
[trusted-publishing decision's](2026-10-20-npm-trusted-publishing.md) interrupted
release completion path while making ordinary repeated dispatches successful.
The [npm CLI publication-check decision](../../implemented/process/2026-10-22-npm-cli-publication-checks.md)
replaces the retry distinction and direct npm HTTP lookup: every attempt now
uses the same existence-only skip, and npm metadata is read through `npm view`.
It owns the current lookup, duplicate-publication and retry rules.

## Alternatives

**Keep source verification for every existing version.** This originally
permitted recovery from any dispatch when source and artifact matched, but
repeated the complete validation workload and rejected ordinary dispatches
after main advanced. Existence-only admission removed that failure for new
dispatches.

**Apply the skip to failed publishing-job retries.** The original decision
retained strict recovery because an accepted npm version would otherwise
prevent completion of its missing tag. The replacement decision adopts the
uniform skip and accepts that a skipped run leaves a missing tag uncreated.

**Use only the workflow run attempt to identify recovery.** An attempt above
one could also be the first publication after failed preparation. The original
preparation-attempt comparison preserved the second preflight in that case.
Uniform preflight now removes the need to classify attempts.

## Consequences

Repeated dispatches for an existing version avoid dependency installation,
testing, packing and publication. A marker from another commit succeeds without
being moved. A tag without an npm record also skips, and an npm record without
a tag skips without repairing the tag.

The original retry mechanism preserved source-bound completion of interrupted
releases. Its replacement gives every invocation the same successful
existing-version result. Workflow and tooling changes remain outside the CLI
runtime release inputs, so this decision does not require a package version
increase.
