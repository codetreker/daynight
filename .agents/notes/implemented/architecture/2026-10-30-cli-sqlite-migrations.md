# Agent Note: Independent CLI SQLite Format Migrations

Status: implemented

## Problem

Local CLI state outlives the process and package that wrote it. Review and
Controller journals already had versioned conversions, while the Worker index
recognized column layouts and the Web execution and resume-lease stores created
unversioned tables. A package update could therefore leave a read command unable
to use otherwise supported retained data, or let different openers disagree on
which conversion and ownership checks were required.

A schema write lock alone cannot exclude an old application process that resumes
writing after the conversion. Query-only maintenance also must not remove a
retained instance lock and erase uncertainty about surviving native agents.

## Decision

Each store explicitly supplies its own format definition and `user_version`
sequence. Baselines and SQL upgrades are independent `.sql` resources. Each owner
selects its directory; top-level filenames define the baseline, versions and
execution order.
The shared executor handles definition validation, source inspection, ordered
synchronous steps and version advancement; connection adapters handle read
snapshots, migration transactions, close errors and diagnostics. SQL scripts do
not own transactions, PRAGMA settings or version writes. JSON conversion and
business admission remain TypeScript responsibilities. Database paths and store
selection remain explicit in code. The
[SQL resource decision](2026-11-02-sqlite-sql-resources.md) owns resource layout,
reference metadata and packaging, including the rationale for replacing the
initial inline definitions without changing these versions or domain ownership.
The [filename-order decision](2026-11-02-filename-ordered-sqlite-migrations.md)
owns how the directory supplies that sequence without a TypeScript step list.
The [requirements](../../../../docs/spec/cli-sqlite-migrations.md) and
[design](../../../../docs/design/cli-sqlite-migrations.md) own the complete behavior
and lifecycle.

Review remains at version 2 and Controller journals at version 5, preserving
their nonzero conversions. Worker uses version 5; retired detailed versions 1–4
remain unsupported. Web execution state and native resume leases use their
independent version 1. The [unversioned reset decision](2026-11-02-unversioned-sqlite-reset.md)
replaces source adoption: all five version-0 databases discard their original
schema and data after domain admission, then rebuild through the baseline and
numbered upgrades. The minimal index still has only its business columns; no
history, identity or recovery ledger is added.

The initial policy adopted known unversioned minimal Worker indexes, supplied
Herdr mode where it was absent and registered Web state while preserving its
existing JSON strings. This preserved useful retained records without making
registration a data-cleaning operation. That rationale remains historical; the
reset decision deliberately gives up unversioned data preservation and removes
its source-specific validation and conversion paths.

Every nonzero source inspection reads its version and schema in one snapshot, including
the writable opener's initial preflight. That short DEFERRED transaction ends
before WAL/FULL configuration; the IMMEDIATE migration transaction then reads
the actual source again. Concurrent commits cannot combine an old version with a
new schema during validation.

Current-format queries also inspect and read their business data in one readonly
snapshot, without additional migration write permission or instance-lock
acquisition. A supported nonzero older format is upgraded, or version 0 is reset,
through a short writable connection before reopening the query snapshot. Missing
databases retain each entrypoint's established meaning; permissions, corruption
and unknown nonzero formats
remain visible failures.

Pure maintenance refuses every preexisting instance lock, including dead or
uncertain owners. It releases only its own record after the gate and business
connections have confirmed closure. Ordinary runtime stale-lock recovery keeps
its existing semantics. Controller migration checks the old writer before DDL;
startup migration and writer admission share a transaction. Native lease
ownership blocks migration whenever any row remains; neither age nor PID
disappearance establishes permission to reclaim it.

Initial lease setup can commit this invocation's INSERT and then fail completion
reporting before returning the connection. When that commit and the original
connection close are both confirmed, preparation reconciles only its own known
key and nonce through a fresh, existing-file, current-format transaction. The
acquisition has not returned, so no new native launch can have begun. A missing
row confirms no retained lease from this attempt; a replacement nonce or unknown
commit/close outcome retains the row. The original reporting error remains the
operation failure, with any reconciliation error aggregated. This is cleanup of
a proven prelaunch acquisition, not stale-lease recovery.

A migration transaction commits reset when required, all pending SQL/JSON steps
and its version updates together. Its explicit synchronous boundary preserves
the original failure if rollback or close also fails. Commit success remains a known fact even
when later restoration of the connection's foreign-key setting, close or
reporting fails. The reset decision owns temporary foreign-key handling and its
post-commit restoration boundary. Database failures are kept outside IPC-only
catch paths; an independent launcher still attempts local stopping while keeping
journal failures and incomplete stop evidence.

This extends the persistence model without reversing the
[minimal Worker index](../simplification/2026-10-27-worker-claim-records.md), the
[Web execution state owner](2026-10-28-web-execution-evidence.md), or the
[native resume ownership](../feature/2026-10-28-controller-native-resume.md)
decisions. It is separate from the removed
[workspace-format converter](../simplification/2026-10-28-remove-worker-workspace-migration.md),
which does not return as a startup dependency.

## Alternatives

**Keep migration control inside every store.** That retains divergent handling of
readonly access, version checks, transactions, error chains and close outcomes.
The store still owns its schema and business preconditions, while common
execution rules are shared.

**Require a writable command before queries can read old state.** This makes
normal reads fail after updates and requires an unrelated operation solely to
perform format work. Automatic pure migration preserves the original query and
keeps current-format reads free of new write requirements.

**Persist a database-family identifier or migration ledger.** The opener already
selects a concrete file and store definition. Another identifier duplicates that
selection, and a ledger adds persistence unrelated to the required version
sequence. Source validation belongs to the selected store.

**Reuse runtime stale-lock takeover for maintenance.** Replacing a dead owner and
then deleting that lock would discard the runtime's retained process
uncertainty. Refusing all preexisting locks preserves that evidence without
inventing another ownership registry.

**Adopt a full migration framework.** Script discovery, external scheduling and
checksum history are not required for these embedded stores. A small executor
with immutable delivered steps supplies the needed atomic conversions without
another runtime dependency.

## Consequences

All actual database access paths share version and failure rules while retaining
independent domain state and migration sequences. Current-format reads can
coexist with WAL writers; actual upgrades may require writable storage and the
end of conflicting or uncertain ownership.

One database's completed conversion is not rolled back when a second database
fails. Startup waits for every required store, and the next open uses each
file's actual version. Large JSON conversions retain one write transaction and
bounded memory rather than exposing partial commits.

Completely unversioned older binaries cannot be made to follow guards they do
not contain. Switching from those binaries requires exiting related old
processes and preserving unresolved ownership evidence; concurrent mixed-binary
operation and automatic downgrade are not guarantees. Unknown nonzero layouts,
hand-edited structures outside accepted versioned definitions and external-file conversions require an explicitly defined
transition rather than heuristic repair. Version 0 follows the reset policy.
