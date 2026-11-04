# Agent Note: Independent CLI SQLite Format Migrations

Status: implemented

## Problem

Local CLI state outlives the process and package that wrote it. Review and
Controller journals already had versioned conversions, while the Worker index
recognized column layouts and the Web execution and resume-lease stores created
unversioned tables. A package update could therefore leave a read command unable
to use otherwise supported retained data, or let different openers disagree on
which conversion and ownership checks were required.

Executable SQL and accepted schema definitions can also drift when maintained
separately. Independent SQL assets make resource loading, execution order and
installed package contents part of whether the CLI can open its supported state.
A zero `user_version` supplies no reliable source-format identity for preserving
arbitrary retained data.

A schema write lock alone cannot exclude an old application process that resumes
writing after conversion. Query-only maintenance must preserve retained instance
locks and uncertainty about surviving native agents.

## Decision

Each store explicitly selects its format and SQL directory, with an independent
`user_version` sequence: Review 2, Worker 7, Web execution state 2, Controller
journal 6 and native resume lease 1. Review and journal retain their existing
nonzero conversions; retired detailed Worker versions 1–4 remain unsupported.
The minimal Worker task index gains no business columns, identity marker or
execution history. The [cleanup retry decision](../bug-fix/2026-11-04-worker-cleanup-retry.md)
adds a separate terminal-cleanup schedule in Worker version 6, preserving
existing project and task rows. The
[resource-state decision](2026-11-04-worker-resource-state.md) adds Worker 7 and
Web 2 migrations that remove cleanup progress fields while preserving identity,
intent, deadlines and retry policy. There is no global version, database-family identifier or
migration ledger.

Five baselines and their numbered upgrades are independent `.sql` resources. Top-level
filenames alone define each owner's baseline, versions and execution order;
TypeScript has no per-step registry or second sequence. A valid next numbered
file automatically enters its owner's chain. Strict discovery rejects malformed
SQL candidates and broken sequences while ignoring unrelated non-SQL entries
and ordinary auxiliary directories. A baseline can start above 1, preserving
Worker's `005-baseline.sql`. The
[design](../../../../docs/design/cli-sqlite-migrations.md#sql-资源与参考结构)
owns the naming grammar and directory inventory.

The same discovered SQL chain builds cached versioned reference metadata in a
short-lived memory SQLite connection during format-module initialization. SQLite
supplies the schema representation, including ALTER results; validators do not
maintain duplicate CREATE definitions. The reference closes before user-store
access and is reused without copying user records or creating another writable
file. Loading remains behind the lazy database-runtime command boundary, so
help, completion and lightweight commands do not initialize database runtimes.
SQL owns statements; TypeScript owns JSON conversion, domain admission,
transactions, connection settings and version advancement. Journal v6 also exports
legacy content to durable pending files before its destructive SQL conversion;
the [file archive decision](2026-10-30-session-file-archives.md) owns that
domain-specific ordering and recovery. The shared runner does not migrate files.

All five business databases discard their original user schema and data at
version 0 after domain admission, then rebuild through the same baseline and
upgrades used by new files. Existing empty version-0 files and query access use
this rule; `allowCreate` controls only missing-file creation. There is no
unversioned source-schema validator, JSON admission model, adoption callback or
source-only SQL. Known valid nonzero migrations preserve their existing data
semantics; unknown, future or unsupported nonzero formats are refused without
reset. Web version 2 removes obsolete cleanup JSON fields in its SQL migration;
current CRUD reads the resulting intent representation without old-field fallbacks.

Version and nonzero source-structure inspection share one snapshot, including a
writable opener's short preflight before WAL/FULL configuration. The IMMEDIATE
write transaction inspects the actual source again. Current-format queries
inspect and read business data in one readonly snapshot without a migration
permit or additional write permission. A query needing reset or upgrade closes
that snapshot, performs admitted maintenance and reopens a current-format
snapshot. Missing-file meanings remain entrypoint-specific; other open failures
remain visible. The [requirements](../../../../docs/spec/cli-sqlite-migrations.md)
and [design](../../../../docs/design/cli-sqlite-migrations.md) own the complete
access and refusal contracts.

Schema reset, pending SQL/JSON steps, version writes and startup share one
synchronous transaction. For a nonempty version-0 reset, the access layer
captures and disables `foreign_keys` before BEGIN. Fresh inspection inside
IMMEDIATE must agree with the selected mode before domain admission or startup;
a raced source permits one read-only handoff to reconfigure outside the
transaction, and another mode change fails. Empty initialization and nonzero
migration retain the original setting. Reset removes triggers and views, then
virtual tables so their modules clean up owned shadow tables. It reloads the
schema with `writable_schema=RESET`, leaving schema writing disabled, before
re-enumerating and removing every surviving user table. FTS5 external-content
tables can survive their virtual table while retaining a cached shadow flag;
refreshing that classification allows their normal deletion. Every actual
nonempty reset passes `foreign_key_check` after startup and
before commit, regardless of the original setting. The database file is retained.

Pure maintenance refuses every preexisting instance lock, including dead or
uncertain owners, and releases only its own record after confirmed business and
gate connection closure. Runtime stale-lock recovery keeps its existing
semantics. Controller owner admission precedes DDL and shares the startup
transaction: absent version-0 execution tables permit reset, but unreadable owner
columns and active or uncertain owners block it. Any retained resume-lease row
blocks reset or migration, regardless of expiry or PID; an absent version-0 lease
table permits reset. These rules preserve ownership evidence without authorizing
native replacement, replay or stale-lease recovery.

An initial lease INSERT can commit before completion reporting fails and the
connection reaches its caller. Only a confirmed commit, confirmed original
connection close and an acquisition that has not returned permit a fresh
existing-file, current-format transaction to reconcile this invocation's known
key and nonce. No native launch can have begun. A missing row confirms no lease
from this attempt; a replacement nonce or unknown outcome retains the row. The
original reporting failure remains primary, with reconciliation failures
aggregated. This is cleanup of a proven prelaunch acquisition.

Precommit failures preserve the original error and any rollback or close error.
After confirmed COMMIT, the access layer records the committed outcome before
restoring and verifying the original foreign-key setting and returning the
connection. Restoration failure closes the connection and reports
`cleanup-failed` at `restore-foreign-keys` with a committed outcome. Later close,
logging or reporting failure also cannot turn a known commit into rollback or
cause replay. Database failures remain outside IPC-only catches; independent
launchers still attempt local stopping while retaining journal failures and
incomplete stop evidence.

The build explicitly copies the two skill bundles and five owner SQL directories
into matching `dist` paths. Recursive, case-insensitive SQL suffix copying
preserves candidate names and bytes so invalid top-level candidates still reach
the strict installed loader. The directory allowlist controls publication scope,
not execution order. Module-relative URLs and the existing `files: ["dist"]`
package rule keep resources available independently of the caller's cwd.
Resource-read and reference-construction failures surface before user-store
access; invalid SQL fails at its reference or migration execution boundary. The
[development guide](../../../../docs/development.md#cli-development) owns build
and installed-resource validation.

This extends the persistence model without reversing the
[minimal Worker index](../simplification/2026-10-27-worker-claim-records.md),
[Web execution ownership](2026-10-28-web-execution-evidence.md) or
[native resume ownership](../feature/2026-10-28-controller-native-resume.md)
decisions. The removed
[workspace-format converter](../simplification/2026-10-28-remove-worker-workspace-migration.md)
does not return as a startup dependency.

## Alternatives

**Keep migration control inside every store.** That retains divergent readonly
access, version checks, transactions, error chains and close outcomes. Stores
retain schema and business preconditions while sharing execution rules.

**Require a writable command before queries can read old state.** Normal reads
would fail after updates until an unrelated operation performed format work.
Automatic maintenance completes the original query while keeping current-format
reads free of new write requirements.

**Persist a database-family identifier or migration ledger.** The opener already
selects a concrete file and store definition. Another identifier duplicates that
selection, and a ledger adds persistence unrelated to the required independent
version sequences.

**Reuse runtime stale-lock takeover for maintenance.** Replacing a dead owner
and deleting its lock would discard retained process uncertainty. Refusing all
preexisting locks preserves that evidence without another ownership registry.

**Adopt a full migration framework.** External scheduling and checksum history
add mechanisms these embedded stores do not require. Filename discovery and a
small synchronous executor provide atomic conversions without another runtime
dependency or migration scheduler.

**Keep SQL inline in TypeScript.** Independent SQL assets make executable
statements directly reviewable and packageable under each store's ownership.
Inline definitions would not provide that resource boundary.

**Externalize execution SQL but retain duplicate validator DDL.** The expected
layout could diverge from the statements used on real databases. Executing the
same chain in SQLite supplies reference metadata without a second CREATE model.

**Parse SQL into a separate schema model.** Reconstructing tables, constraints
and indexes adds SQL interpretation solely to align validation with execution.
SQLite already interprets those statements; finite supported-layout checks do
not require a general parser, schema-diff engine or repair facility.

**Keep an explicit TypeScript step registry.** An added numbered SQL file could
be packaged but inactive until another source file changed. A second version
list could also disagree with filename order. Filenames supply one authority.

**Mix source references and conditional adoption with ordinary upgrades.** An
unconditional filename sequence could execute a source-only CREATE layout or a
conversion intended for only one source. Version-0 reset removes those separate
roles; top-level discovery remains restricted to ordinary baseline and upgrade
SQL.

**Preserve recognized unversioned state.** Retaining minimal Worker rows,
supplying legacy Herdr mode and registering Web JSON without rewriting strings
preserve useful data. They require a separate accepted-source definition and
conditional conversion outside the numbered chain. Reset gives zero one meaning
across every business database and deliberately gives up that preservation.

**Defer foreign keys while dropping the old schema.** Deferral does not defer
NOT NULL failures caused by SET NULL or SET DEFAULT actions, so valid unknown
version-0 cycles can prevent schema removal. Disabling enforcement before BEGIN
removes dependence on source referential actions; a final foreign-key check
validates the rebuilt result before commit.

## Consequences

All access paths share version and failure rules while retaining independent
domain state. Version 0 is destructive even when its schema resembles the current
format, including reads of existing files. Domain ownership can still refuse
reset. Known valid nonzero upgrades retain data, and current-format reads can
coexist with WAL writers. Actual maintenance may require writable storage and
the end of conflicting or uncertain ownership.

Each file commits independently. One completed conversion is not rolled back
when another database fails; startup waits for every required store and the next
open uses each file's actual version. Large JSON conversions retain one write
transaction and bounded memory. Reset and upgrades cannot leave a partial
schema, but transaction atomicity does not promise byte-for-byte restoration of
database/WAL files or journal-mode settings.

SQL and cached reference schemas share one source. Missing resources, malformed
chains and invalid SQL remain visible errors with no inline fallback. Build and
resource-copy scripts are release inputs: package validation compares complete
source inventories and exact copied bytes, then exercises installed SQL. Without
a manifest or second expected sequence, a continuous directory cannot reveal an
intended missing final file; the target is its actual last file. Retaining
delivered SQL therefore remains a source-review and installation-validation
responsibility.

The five target schemas and startup callbacks contain no foreign keys. A future
target format or startup action relying on foreign keys requires reconsidering
the reset boundary. Missing virtual-table extensions or corrupt DDL can still
fail and roll back reset. Successful reset does not prove that earlier native
execution stopped or authorize replay of unknown input.

Completely unversioned older binaries cannot follow guards they do not contain.
Switching requires exiting related old processes and preserving unresolved
ownership evidence; mixed-binary operation and automatic downgrade are not
guaranteed. Unknown nonzero layouts, hand-edited structures outside accepted
versioned definitions and external-file conversions require explicitly defined
transitions rather than heuristic repair.
