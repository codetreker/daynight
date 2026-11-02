# Agent Note: Reset Unversioned SQLite Business Databases

Status: implemented

## Problem

A zero SQLite user_version does not establish a supported data format. Admitting
individual historical layouts requires source-only schemas, conditional SQL and
JSON validation for state that has no recorded version. Different handling for
empty files and recognized unversioned files also makes the outcome depend on
which entrypoint opens the same existing file.

## Decision

All five CLI business databases reset user_version 0 after their existing domain
admission checks: Review state, the Worker claim index, Web execution state,
Controller journals and native resume leases. Reset discards the original user
schema and data, then executes the owner's filename-ordered baseline and all
upgrades. Existing empty version-0 files follow the same path, including query
access. Missing-file behavior remains entrypoint-specific; allowCreate controls
only permission to create a missing file.

The shared format definition has no unversioned validator or adoption callback,
and inspection and upgrade have no empty-file permission argument. Worker
six-column source/adoption SQL and all version-0 schema or JSON source-validation
paths are removed. Five baselines and five upgrades remain. The versions are
unchanged: Review 2, Worker 5, Web 1, journal 5 and resume lease 1. Known valid
nonzero upgrades preserve their existing data semantics; unsupported, unknown or
future nonzero versions, including Worker 1–4, are refused without reset. Web's
current-version CRUD retains its existing JSON parsing and default-field rules.

The access layer captures the connection's original foreign_keys setting and
temporarily disables it outside BEGIN only for a nonempty version-0 reset.
Fresh inspection inside IMMEDIATE must agree with that mode before maintenance,
Controller-owner or resume-lease admission and startup can run. A raced source
can end that read-only transaction and select the correct mode outside it once;
another mode change fails. Empty version-0 initialization and nonzero migrations
keep the original setting. Low-level upgradeSqlite requires callers to disable
foreign keys before BEGIN for a nonempty version-0 reset.

Reset drops user triggers and views, then virtual tables before ordinary tables,
and leaves virtual-table shadow cleanup to their owner. Schema removal,
baseline, upgrades, records, user_version and startup commit or roll back
together. Every actual nonempty version-0 reset must pass foreign_key_check after
startup and before COMMIT, regardless of the connection's original foreign-key
setting. Precommit failures retain the existing rollback, outcome and private
connection-close boundary, preserving the primary failure. Foreign-key setting
restoration belongs only to the post-commit connection-return boundary. The
database file is neither deleted nor replaced. The observable transition is reset rather than
adopted. The access layer records confirmed commit before restoring and verifying
the original foreign_keys setting, then returns the connection. Restoration
failure closes the connection and reports cleanup-failed at restore-foreign-keys
with a committed outcome; it cannot replay the committed work.

A version-0 journal without an execution table can reset. An existing execution
table must permit reading id and owner_pid; malformed columns or an active or
uncertain owner block reset before DDL. Any retained row in an existing leases
table blocks reset or migration, regardless of expiry or PID; a version-0 file
without that table can reset. These checks do not authorize native-process
replacement, replay, stale-lease recovery or destructive resource cleanup.

This supersedes only the unversioned adoption policy in the
[original migration decision](2026-10-30-cli-sqlite-migrations.md), the
[resource decision](2026-11-02-sqlite-sql-resources.md) and the
[filename-order decision](2026-11-02-filename-ordered-sqlite-migrations.md).
Their ownership, nonzero migrations, resource loading, snapshot, transaction and
failure rules remain. The [requirements](../../../../docs/spec/cli-sqlite-migrations.md)
and [design](../../../../docs/design/cli-sqlite-migrations.md) own the complete
current behavior and mechanism.

## Alternatives

**Keep known-source unversioned adoption.** The original migration policy
preserved minimal Worker rows, supplied Herdr mode to six-column indexes and
registered existing Web JSON without rewriting strings. That preserved useful
unversioned state, but required a separate accepted-source definition and
conditional conversion outside the numbered chain. The reset policy gives zero
one meaning across every business database and deliberately gives up that data
preservation.

**Defer foreign keys while dropping the old schema.** Deferral does not defer
NOT NULL failures caused by SET NULL or SET DEFAULT actions. A valid unknown
version-0 schema can therefore contain cycles that this approach cannot drop.
Temporarily disabling enforcement before BEGIN removes that dependence on the
source's referential actions, while checking the rebuilt result before commit.

## Consequences

Version 0 is destructive to stored business state even when its schema resembles
the current version. Reset is automatic on access, including reads of an
existing file; its ownership checks can still refuse the operation. Current
version reads remain read-only, and valid nonzero migrations preserve data.

No new source-schema compatibility layer or stricter Web version-1 JSON contract
is retained. Baseline and numbered upgrades provide the target schema for both
creation and reset. The five current target schemas and startup callbacks have
no foreign keys; future target formats or startup actions that rely on foreign
keys require reconsidering this reset boundary. Missing virtual-table extensions
or corrupt DDL can still fail and roll back the reset. Unknown ownership remains
visible and retained; a successful
reset does not establish that an earlier native execution stopped or that an
unknown input may be replayed. File lookup, packaging, cwd independence and
missing-file semantics remain with their existing owners.
