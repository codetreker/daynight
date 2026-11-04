# Agent Note: Worker Git Fixture Seeds

Status: implemented

## Problem

Worker worktree cases repeatedly constructed the same initial repository before
exercising the manager. Each construction started six native Git commands for
initialization, identity configuration, index/commit creation and remote setup.
Native Windows validation spent substantially more time in this file than
Linux, while each case still required an independently mutable repository.

## Decision

The Worker worktree test file owns one immutable starting repository for each
used ref format, `files` and `reftable`. Each seed is prepared lazily with the
existing native construction sequence, including committed line-ending
attributes and the original tracked bytes. A file-owned directory retains the
seeds until all cases finish; teardown joins any seed preparation before removing
that directory, including after a preparation failure.

Each case copies its format's completed repository into its own Unicode/spaced
path with the same synchronous recursive-copy operation used by the review
fixture. These are independent file copies, with no hardlinks or object
alternates. Copying is setup work before behavioral operations begin. Case-owned managers, operations, branches, worktrees, ownership
markers, Git administration and dirty files retain their existing lifetimes.
The original case callbacks, assertions and time limits remain unchanged.

A native isolation case for each format changes one copy's tracked bytes and
ref, then corrupts its commit object. Real Git reads prove that the copied
object is damaged while the seed and sibling preserve the original bytes,
refs and readable object. These checks cover copy isolation directly rather
than relying on passing manager behavior alone.

The [archived review Git decision](../../archived/testing/2026-10-18-parallel-git-validation.md)
records the existing immutable-seed/private-subject pattern. Its bare-origin
factory also owns review-specific SQLite and observation state, so the Worker
file applies the same lifecycle locally without coupling its fixture to those
review responsibilities. The [behavior-budget decision](2026-10-29-worker-worktree-behavior-budget.md)
continues owning the discovery hooks and callback boundaries.

## Alternatives

**Reuse a mutable repository or worktree across cases.** Refs, index state,
filesystem identity, ownership markers and cleanup are the subjects under test.
Sharing them would let one case change another case's starting state.

**Extract a general repository seed framework.** The existing review factory
and this Worker fixture have different starting graphs and business state.
A local per-format seed lifetime removes the repeated work without introducing
a shared protocol or coupling either fixture to the other's manager.

**Copy every entry through asynchronous filesystem promises.** The fixture
already performs blocking native Git setup. Asynchronous recursive copies add
per-entry scheduling for many small repository files; the local matched-case
sample showed no speedup. The existing synchronous review-fixture copy avoids
that scheduling while retaining private files and explicit setup ownership.

**Split the Worker file or increase workers.** These choices change scheduling
while retaining repeated construction. The file remains sequential under the
existing isolated worker defaults; removing redundant preparation is separate
from job or file scheduling.

## Consequences

The initial six-command sequence runs once per used format. Every case still
executes the real manager operations and uses a private repository; seed
construction does not precompute worktrees or managed registrations. A failed
seed preparation remains a test failure and teardown retains ownership of its
partial directory.

Copying repository files also has a platform-dependent cost. Local Linux
measurements and summed per-file times cannot establish a hosted Windows
speedup. The [timing report](../../../../docs/research/windows-ci-performance.md)
owns measured revisions and the limits of cross-run comparisons. Native
validation must retain both ref backends, original assertions, case deadlines,
worker defaults and cleanup coverage.
