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
sequence. The shared executor handles definition validation, source inspection,
ordered synchronous steps and version advancement; connection adapters handle
read snapshots, migration transactions, close errors and diagnostics. Database
paths and store selection remain explicit in code. The
[requirements](../../../../docs/spec/cli-sqlite-migrations.md) and
[design](../../../../docs/design/cli-sqlite-migrations.md) own the complete behavior
and lifecycle.

Review remains at version 2 and Controller journals at version 5, preserving
their existing conversions. Known unversioned minimal Worker indexes enter
version 5; retired detailed layouts remain unsupported. Web execution state and
native resume leases establish their independent version 1. Registration keeps
current records and the existing Web JSON strings instead of turning versioning
into a data-cleaning operation. The minimal index still has only its business
columns; no history, identity or recovery ledger is added.

Current-format queries inspect and read within one readonly snapshot, without
additional migration write permission or instance-lock acquisition. A supported
older format is upgraded through a short writable connection before reopening
the query snapshot. Missing databases retain each entrypoint's established
meaning; permissions, corruption and unknown formats remain visible failures.

Pure maintenance refuses every preexisting instance lock, including dead or
uncertain owners. It releases only its own record after the gate and business
connections have confirmed closure. Ordinary runtime stale-lock recovery keeps
its existing semantics. Controller migration checks the old writer before DDL;
startup migration and writer admission share a transaction. Retained native
leases block migration and are not reclaimed by age or PID disappearance.

A migration transaction commits all pending SQL/JSON steps and its version
updates together. Its explicit synchronous boundary preserves the original
failure if rollback or close also fails. Commit success remains a known fact even
when a later close or reporter fails. Database failures are kept outside IPC-only
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
not contain. Initial adoption requires exiting related old processes and
preserving unresolved ownership evidence; concurrent mixed-binary operation and
automatic downgrade are not guarantees. Unknown layouts, hand-edited structures
outside the accepted source definitions and external-file conversions require an
explicitly defined transition rather than heuristic repair.
