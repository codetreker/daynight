# Agent Note: Parallel Git Validation

Status: implemented

## Problem

The Git lifecycle tests dominated native Windows validation even though each
case used a separate repository and database. In three successful CI runs, the
single Git test file took 126.561 to 196.409 seconds. Other test workers finished
while its independent cases continued sequentially. Every case also repeated
eleven native Git commands to construct the same initial bare repository.
The [timing report](../../../../docs/research/windows-ci-performance.md) owns
the measurements and source revisions.

## Decision

Git scenarios are divided into separate test files for repository snapshots and
failure handling, ownership and cleanup, configuration and submodules,
administrative authority, and the two sparse-configuration scopes. Vitest's
existing isolated file workers schedule these suites in parallel. Cases within
each file remain sequential. Every platform retains Vitest's default worker
limit, `forks` pool and file isolation. The native Windows split-suite run used
three workers and passed ordinary tests in 110.67 seconds. A six-worker
experiment took 120.15 seconds and failed four existing five-second version
checks, so the workflow retains the default limit.

Each file explicitly owns a fixture factory and its lifecycle hooks. The factory
constructs one bare-origin seed with native Git, then copies it into a unique
directory for every case. Copies contain independent files, objects and refs;
they use no hardlinks or shared object alternates. SQLite databases, clones,
worktrees, command interceptors and observation state remain private to each
case. Only the seed survives case cleanup, and file cleanup removes it. A
factory initialization callback can prepare additional immutable source objects
and refs before case copies exist. Both sparse suites use it to build their
identical sparse source graph once per file. Each case still reads the copied
source refs, records the initial and sparse observations in its own SQLite
store, and runs native clone/configuration/fetch/index/worktree operations and
byte-preservation snapshots.

Version-gate tests separately copy a file-owned immutable bare seed containing
only the default parentless `1.0.0` base objects. Scenario commits and refs remain
private; prerelease roots, absent objects/manifests and unrelated histories are
still constructed by their owning cases. The seed replaces repeated identical
source construction without precomputing the behavior being tested. The
[CI efficiency decision](2026-10-21-ci-validation-efficiency.md) records this
extension alongside other workload optimizations.

All existing Git scenarios and assertions remain exercised. The manager still
executes real clone, fetch, worktree, sparse-checkout and submodule operations.
Fixture commands retain their dynamic environment filtering, Unicode and space
paths, fixed commit identities and committed byte-preservation attributes.
The [batched-object decision](2026-10-21-batched-git-fixture-objects.md) extends
source preparation with one native `fast-import` stream per snapshot. It keeps
this note's per-file seed lifecycle, private mutable subjects and all native
manager operations; the historical split-suite measurements above retain their
original implementation and tested source.
The three-platform workflow and installed CLI acceptance retain their full
workload and existing time limits.

## Alternatives

**Run cases concurrently inside the original file.** Environment stubs are
process-wide, and case cleanup closes databases and removes directories owned
by its fixture factory. Concurrent cases could alter another case's environment
or remove its active resources. File isolation preserves those ownership rules.

**Reuse prepared clones or worktrees.** Their administration pointers, refs,
filesystem identity and persisted registration are test subjects. Copying only
the initial bare origin removes repeated setup without bypassing those subjects.

**Raise the Windows worker limit to six.** The first split-suite run used three
workers and kept later Git files queued; six could overlap more native command
waits. The native experiment instead took 120.15 seconds versus 110.67 and four
version-gate cases exceeded their unchanged five-second limit. Greater file
concurrency did not improve that runner's observed throughput. Default worker
sizing keeps the passing acceptance criteria and avoids the additional resource
pressure. The [timing report](../../../../docs/research/windows-ci-performance.md)
retains the failed experiment and its limits.

**Optimize dependency caching or repeated builds first.** The latest baseline
spent five seconds installing dependencies and 201 seconds running ordinary
tests. These other costs do not explain the dominant Windows delay. They remain
independent optimizations if later measurements make them material.

## Consequences

The worker scheduler distributes native Git work across independent cases.
Additional test files create some worker overhead and simultaneously active
private fixtures. Worker limits and CI runner size remain unchanged; the rejected
six-worker experiment demonstrates that more concurrency can increase native
command costs and exhaust existing test deadlines.

Immutable seed setup remains file-owned, native Git writes each source snapshot
through one import, and every case still creates its own real repository state. Sparse source preparation and the version-gate
base share only immutable source objects, without increasing workers, adding
same-file concurrency or reusing mutable test subjects. Future scenarios must
retain per-case mutable
resources and per-file cleanup ownership. The optimization changes validation
structure and is exempt from the package version policy.
