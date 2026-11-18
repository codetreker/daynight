# Agent Note: Worker Worktree Scan Fixtures

Status: implemented

## Problem

Partial worktree scan cases inspect existing Git registrations and manifests.
Preparing those inputs through the Worker creation workflow also clones a
private bare origin, configures its transport, fetches the starting commit,
and prepares a new task branch for every registration. The scan outcomes do
not depend on fetching that commit. In the
[November 18 macOS PR job](https://github.com/codetreker/daynight/actions/runs/44223609888/job/134531390771),
the complete Worker worktree test file took 102 seconds. That duration includes
other Git workflows as well as scanning and fixture setup.

## Decision

The partial resource scan cases that need registrations copy an independent
files-backend repository from the existing
[immutable seed](../../archived/testing/2026-11-04-worker-git-fixture-seeds.md).
They prepare the repository through the Worker manager, create each required
checkout with native `git worktree add` on the seed commit, and publish its
manifest through the real store. Expected bindings are assembled independently
of the production scan. The cases still modify native metadata and exercise the
real scan, inspection, and removal paths. Separate cases retain the full Worker
preparation, fetch, cancellation, and recovery workflows and their private
origins.

## Alternatives

**Copy a second immutable seed for the bare origin.** This preserves the
same setup workflow, including preparation and fetch for every registration.
Earlier complete-file measurements did not establish a benefit from replacing
only the per-case bare clone.

**Stub Git queries or build registration metadata by hand.** These cases
depend on native path and registration semantics, including linked checkout
pointers, missing leaves, and physical file identities. Native Git creates the
ordinary starting state before each case introduces its specific fault.

## Consequences

The partial scan cases create only the Git state they inspect. Each case still
owns its checkout, manifests, manager, operations, and removal of the private
repository. Starting from a published registration means these cases do not
also incidentally check creation from a fetched remote default. The separate
creation tests retain that proof. CI selection, worker configuration, and test
deadlines are unchanged.
