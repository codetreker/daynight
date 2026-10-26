# Agent Note: Durable Review State

Status: implemented

## Problem

Polling and review completion observe a PR at different times. A restart can
otherwise forget the initialization boundary, reuse an exhausted attempt budget,
or mistake an uncertain execution for a completed review. Persistent records
must distinguish these cases without claiming to prove external process or
GitHub state.

## Decision

The state module uses synchronous, short SQLite transactions for repositories,
pull requests, and reviews. Repository identity combines host and GitHub ID;
transport spelling and the configuration coordinate do not create a new
initialization identity. A null cutoff means uninitialized, zero means a
successful empty scan, and an initialized cutoff is immutable.

Observed target changes and resolved-feedback follow-ups advance a desired
revision. A review captures its own immutable
revision, head, and target branch, with the base commit pinned before launch.
Completion advances only that captured revision. A partial unique index includes
preparing, running, retry_wait, and interrupted reviews so that one PR has one
active record. New observations cannot discard the running record or its pending
successor. Failed revisions remain suppressed across database reopen and cannot
obtain a fresh budget by changing review IDs.

The attempt count records committed agent launch intent. Preparation alone does
not consume an agent attempt; a committed launch still consumes one if spawning
fails or the process crashes before execution is confirmed. Scheduling delays
and preparation retry policy belong to the coordinator. Retry records retain
the captured target, session, budget, and latest attempt evidence. Prior log files
remain under their review and attempt paths.

The [bundled skill](../../implemented/architecture/2026-10-20-bundled-review-skill.md) uses one attempt for
sequential discovery and review children. `clearProcess` requires a matching
current running attempt, exact PID and process identity, plus caller-supplied
process-exclusion proof. It clears only that process pair and retains the
attempt's count, target, logs and running status before the next child is
recorded. The database neither excludes a process nor authorizes overlap by
itself; no schema change or legacy-data fallback is needed.

Opening a runtime database never authorizes recovery. Interrupted records stay
active until the caller explicitly confirms that previous processes have stopped.
Preparing and running work cannot be silently displaced by a newer observation.
The coordinator owns operation exclusion; a database assertion records its
conclusion without independently proving process absence.

Session establishment is monotonic. Worktree registration and cleanup state
survive reopen. Closure requires cleanup; reopening withdraws deletion eligibility
without clearing `cleanup_pending` or its error. Cleanup candidates therefore
include open PRs with unresolved markers. After operations are conclusively
stopped and agents excluded, `cancelCleanup` clears only that marker and error,
retaining the path and session. A PR observation cannot establish this proof.
SQLite registration does not replace Git identity checks, validate session files,
create directories, or delete a worktree.

The database uses WAL, FULL synchronization, a bounded busy timeout, and explicit
schema versions. Migration and transition failures propagate. No transaction
contains external commands, and no foreign keys are needed for these
application-owned records. The [architecture](../../../../docs/design/daynight-review.md)
owns the public transition details. This mechanism implements the persistence
part of the [foreground CLI decision](2026-10-16-foreground-review-cli.md).

The [local status listing](../feature/2026-10-18-review-status-listing.md) reads
repositories, open PRs and their current or older active reviews in one read-only
transaction. Reopened PRs keep unresolved cleanup barriers visible separately
from their current and older active review records. The listing reports those
markers and saved errors without cancelling cleanup. It checks the existing
schema without migration and returns absent
state without creating a database. It does not recover records, take the review
instance lock or establish process liveness. SQLite may still manage WAL/SHM
coordination sidecars while reading an existing database. Invalid or unsupported
state remains an error rather than an empty listing.

Complete [GitHub observation passes](2026-10-17-github-observation.md) use one
`applyRepositoryPoll` transaction for their cutoff or deduplicated snapshot and
successful-poll timestamp. It reuses the same state transitions without exposing
a general transaction callback. A failure rolls back the whole observation;
recording the failure itself is a separate operation.

`better-sqlite3` 13.0.3 supplies Node-API binaries and has no install lifecycle
script. The original pnpm 10.34.5 toolchain nevertheless detected its
`binding.gyp` as requiring a build, without consulting `gypfile: false`. That
observation motivated blocking unnecessary implicit compilation. The workspace
retains that decision with `allowBuilds.better-sqlite3: false` under the
[pnpm 11 toolchain](../../implemented/process/2026-10-22-pnpm-oidc-publication.md). See the inspected
[package manifest](https://github.com/WiseLibs/better-sqlite3/blob/dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb/package.json),
[pnpm build detection](https://github.com/pnpm/pnpm/blob/702ad5f860ffd50d64a3a711d9f8a3da16fc796e/exec/pkg-requires-build/src/index.ts#L3-L16),
and [ignored-build behavior](https://github.com/pnpm/pnpm/blob/702ad5f860ffd50d64a3a711d9f8a3da16fc796e/exec/build-modules/src/index.ts#L83-L105).

## Alternatives

**Use only the latest head SHA as progress.** A head alone cannot represent
Draft-to-ready, reopening, or target-branch changes, and completing an old run
could erase a newer pending trigger. Separate desired and captured revisions
preserve these events.

**Create a new review record for every retry.** This makes attempt exhaustion
and unknown prior publication easy to lose. A retry retains the review identity
and consumed budget; only a new observed revision permits fresh work.

**Store a separate attempt ledger in JSON inside each review.** The current
recovery path needs the persisted count, launch intent, process/log references,
and retained files. A second embedded history format would duplicate lifecycle
state without adding a required recovery operation.

**Recover running records when opening the database.** SQLite cannot establish
whether external children remain alive. Explicit interruption and caller-verified
process exclusion preserve that uncertainty and prevent overlapping executions.

## Consequences

Real SQLite tests can verify the cutoff, revision attribution, retry exhaustion,
active uniqueness, rollback, locking, and persisted ownership state independently
of network or agent execution. Native CI also exercises the packaged SQLite
binary on each supported platform.

The [foreground coordinator](2026-10-17-foreground-review-coordination.md) composes
polling, Git preparation, agent invocation and process evidence around these
transactions. A caller supplies timestamps, IDs and external outcomes; the
database does not manufacture evidence of successful review publication. The
[conversation-cycle decision](../../implemented/architecture/2026-10-21-review-conversation-cycle.md) partially
supersedes the original head-only follow-up and marker-only completion behavior.
Schema version 2 adds `review_publications` records for the publisher captured
before launch, pending remote verification,
verified approval or commented results, exact review/thread identities, identity
format provenance and consumed follow-ups. Version 1 completed records migrate
as `legacy`; active unfinished records migrate as `prepared`, both with explicit
legacy identity format and unknown publisher until historical remote evidence
establishes the actor. New rounds and new writes use strict identities. The
migration preserves existing records; supported legacy
listing remains read-only. Marker acceptance and process exclusion precede durable
pending confirmation, whose remote retries do not relaunch the model or consume
its budget. A verified comment can produce one same-target successor after all
conversations resolve, while a matching approval settles its target.
