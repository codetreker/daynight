# Agent Note: Batched Git Fixture Objects

Status: implemented

## Problem

Native Git tests repeatedly start processes to write blobs, assemble trees and
write one commit before reaching the behavior under test. Per-file immutable
seeds already avoid duplicated initial repositories, but scenario-specific
snapshots still pay several process starts for one logical source state.
Reducing that preparation must preserve exact objects, parent histories and
private repository state without changing real manager operations or test
concurrency.

## Decision

`test/helpers/git-objects.ts` owns `writeGitSnapshot`. It accepts the existing
native Git executor, typed path entries, the exact commit message and ordered
parents. One `git fast-import` stream writes a complete snapshot and returns its
commit ID through `get-mark`. A unique private ref is reset within the same
stream, leaving no fixture ref behind. Fixed author/committer metadata preserves
the existing commit bytes and IDs. `deleteall` makes each entry list the complete
snapshot rather than inheriting omitted paths from its parent.

Paths use quoted UTF-8 octal bytes, and inline contents declare their byte length.
Encoding preserves accepted path bytes while native Git retains its platform's
path validation. Windows-invalid names remain native errors. Typed entries
preserve ordinary/executable files and symbolic links as contents,
and existing trees or gitlinks as object references. Sparse fixture entries and
version-gate file maps use the same writer. `fastimport.unpackLimit=0` keeps small
imports packed, avoiding an additional native unpacking process. Native Git
failures propagate through the supplied executor.

This extends the source-construction mechanism of the
[parallel Git validation decision](2026-10-18-parallel-git-validation.md), retaining
its ownership rules. Each test file owns its immutable seed and cleanup; every
case has a private upstream, refs, SQLite observations, clones and worktrees.
Only object preparation is batched. Actual clone, fetch, sparse-checkout,
submodule, index and worktree operations and their existing assertions remain
native. Worker counts, the `forks` pool, test deadlines and product code are
unchanged.

The [snapshot contract tests](../../../../packages/daynight/test/tooling/git-objects.test.ts)
use portable UTF-8 and space-containing paths on every platform to assert exact
object IDs, ordered parents, modes, referenced trees and gitlinks.
A separate path case verifies accepted Unix path bytes and native Windows
rejection of invalid names while retaining refs/HEAD/config. Missing-parent
errors remain visible. The existing Git and version scenarios remain responsible
for their original behavior. Commands and source-bound evidence interpretation
belong to the [repository validation guide](../../../../README.md#validation); the
[Windows timing report](../../../../docs/research/windows-ci-performance.md)
retains the earlier split-suite measurements and their original source.

## Alternatives

**Keep separate blob, tree and commit commands.** This preserves native object
construction but starts several Git processes for each snapshot. A single
native import retains Git's object encoding and error handling while batching
the preparation work.

**Move fixture construction into global setup.** A shared mutable lifecycle would
cross existing isolated file workers and complicate per-file cleanup, environment
stubs and scenario ownership. File-owned immutable seeds remain the unit of
reuse; their private case copies continue to hold every mutable test subject.

**Add threads or increase test concurrency.** This overlaps process creation
without removing it and changes resource contention and ownership conditions.
Batching reduces preparation commands within the existing sequential cases and
default isolated-file scheduling.

## Consequences

Snapshot preparation uses fewer native process starts while its resulting Git
objects, parent graph and observable repository state retain their original
meaning. Source fixtures can express nested paths and modes without constructing
intermediate tree commands at every caller.

The helper depends on Git's import protocol and packed-object support; contract
tests make differences in object bytes or leaked refs visible. Local process
counts or elapsed times do not establish native Windows throughput or a hosted
workflow result. Timing conclusions remain tied to the actual tested revision,
platform and complete CI workload.
