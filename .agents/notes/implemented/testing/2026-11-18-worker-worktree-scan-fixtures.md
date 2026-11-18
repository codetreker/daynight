# Agent Note: Worker Worktree Scan Fixtures

Status: implemented

## Problem

Scan, lookup, metadata inspection, and cleanup tests often start with an
existing Git registration and manifest. Preparing that state through Worker
creation clones a private bare origin, configures its transport, fetches the
starting commit, and creates a task branch. These setup operations are outside
the behavior exercised by the existing-state cases. The full file took 102
seconds in a [November 18 macOS PR job](https://github.com/codetreker/daynight/actions/runs/44223609888/job/134531390771),
including creation, scanning, cleanup, and fixture setup.

## Decision

The partial scans and selected existing-state cases copy an independent
files-backend repository from the [immutable seed](../../archived/testing/2026-11-04-worker-git-fixture-seeds.md).
Cases that need a registration prepare the repository through the Worker
manager, create the checkout with native `git worktree add` on the seed
commit, and publish its manifest through the real store. Expected bindings are
assembled independently of the production scan. Cases that only need the
primary checkout use the repository copy directly.

## Alternatives

**Copy a second immutable seed for the bare origin.** This preserves the
per-registration preparation and fetch workflow. Earlier complete-file
measurements did not establish a benefit from replacing only the per-case
bare clone.

**Stub Git queries or build registration metadata by hand.** These cases
depend on native linked-checkout pointers, missing leaves, and physical file
identities. Native Git creates the starting state before each case introduces
its specific fault.

## Consequences

Each case owns its checkout, manifests, manager, operations, and removal of
the private repository. Metadata faults and interruptions still exercise the
real lookup, inspection, and removal paths. Separate cases prove creation
from a fetched remote default and retain the full preparation, cancellation,
and recovery workflows with their private origins.
