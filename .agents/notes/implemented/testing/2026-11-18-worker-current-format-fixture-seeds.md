# Agent Note: Worker Current-Format Fixture Seeds

Status: implemented

## Problem

The current-format tests recreated a one-commit checkout and a bare origin
for every case. The cases require independently mutable Git state for
registration, recovery and pointer damage. Several cases reach a repository
or ownership decision without fetching.

## Decision

The [current-format test file](../../../../packages/daynight/test/commands/worker/worktree-current-format.test.ts)
owns a lazy native checkout seed and a bare origin derived on first use.
The seed commit disables automatic maintenance so copying can begin as soon
as the Git command returns. It follows the private file-copy lifetime of the
[Worker Git fixture seed decision](../../archived/testing/2026-11-04-worker-git-fixture-seeds.md).

Every case copies the checkout into its own directory. Fetch cases also copy
the bare seed, which Git clones with independent object files. Each checkout
retains the canonical origin and rewrites it to its private local bare path.
For cases that exercise repository or ownership decisions alone, leaving
that path absent makes an unexpected fetch fail locally. Teardown waits for
seed construction to settle before removing the seed root.

## Alternatives

**Create a checkout and bare origin for every case.** This repeats the same
native bootstrap and object setup while providing the same starting graph
to each case.

**Share a live bare origin or checkout.** That shares object and ref mutations
across cases and couples cleanup to other cases' resources. Copying physical
files gives each case independent writable state.

## Consequences

The 18 cases use 28 fixture Git launches where the previous setup used 180.
The ten cases that exercise fetch still use native Git against their private
origins. Registration, recovery and refusal checks operate on each case's
own checkout, refs, objects and manifest.
