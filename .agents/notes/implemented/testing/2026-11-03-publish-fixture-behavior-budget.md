# Agent Note: Publish Fixture Behavior Budget

Status: implemented

## Problem

The real release-packing test stages authored metadata and built output, then
initializes a private Git checkout before invoking release preparation. When
all of that preparation shares a default five-second callback with Git revision
checks, npm packing and receipt assertions, fixture bootstrap consumes part of
the behavior budget. A callback timeout alone does not identify which phase
was slow.

## Decision

The [authored-package case](../../../../packages/daynight/test/tooling/publish.test.ts)
owns a nested preparation hook. It creates its private directories, authored
manifest, built output and source checkout, and returns their exact source SHA.
The failing prepack script remains part of that manifest so the real packing
operation must continue to suppress lifecycle scripts.

The callback retains wrong-revision refusal, the real npm pack operation and
all source SHA, integrity, manifest, archive-content and receipt assertions.
They inspect the same produced tarball and receipt under the existing
five-second behavior budget. Other command-wrapper cases do not run this hook.
The existing per-test environment restoration and directory cleanup cover
resources created by the hook, including preparation or assertion failures.

This applies the [native worktree fixture decision](2026-10-29-worker-worktree-behavior-budget.md)
to release preparation without changing publishing behavior or timeout values.

## Alternatives

**Increase the callback timeout.** That would leave unrelated preparation and
release behavior in one budget and make a delayed native operation harder to
attribute.

**Split packing assertions into independent cases.** That would repeat native
packing or share a mutable artifact, while losing the guarantee that all
assertions describe the same release receipt and tarball.

## Consequences

The existing preparation and callback deadlines bound separate responsibilities.
Every native Git and npm operation remains real, and the original assertions
remain in the callback. Historical macOS callback durations lack per-process
measurements; this separation does not identify the delayed command in a past
run. Local phase measurements and native CI provide evidence for the resulting
test structure without redefining the production operation's guarantees.
