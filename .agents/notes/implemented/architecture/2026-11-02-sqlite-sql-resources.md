# Agent Note: SQLite SQL Resources and Reference Schemas

Status: implemented

## Problem

A database format's executable SQL and the structure accepted by its validator
must describe the same layout. Keeping them as independent TypeScript CREATE
definitions makes a SQL change require a matching edit in another schema
representation. Separating SQL into files also makes resource loading and package
contents part of whether an installed CLI can open its supported local state.

## Decision

Each database owner keeps baseline, upgrade and known-source SQL in its own
`sqlite/` directory. TypeScript registers every resource through a fixed URL and
associates upgrades with explicit versions; filenames and directory enumeration
do not choose execution order. SQL files own SQL statements, while JSON
transforms, domain admission, transaction boundaries and `user_version` writes
remain in TypeScript. The
[migration decision](2026-10-30-cli-sqlite-migrations.md) continues to own versions,
atomicity and process/lease responsibilities.

`platform/sqlite-sql.ts` loads the registered SQL and constructs cached reference
metadata during format-module initialization. It executes the same baseline and
upgrade chain in a short-lived memory SQLite database, captures SQLite's own
`sqlite_schema` metadata at each explicitly registered step and confirms the
reference connection is closed before a user database is opened. Known Worker
six-column source SQL supplies its separate reference layout. The Worker adoption
script runs only in the actual adoption transaction; it is covered by the same
rollback guarantees rather than treated as pre-executed reference SQL.

This reference construction does not copy user data, require another writable
file or add a user-database marker. It happens when the owning runtime module is
loaded, preserving the existing lazy CLI command boundary: help, completion and
other lightweight commands do not load database runtimes. Reference metadata is
reused by later source checks rather than creating a database per access.

The initial migration implementation kept executable and expected CREATE
layouts inline. That was adequate while introducing version and ownership
rules, and kept reference construction out of a user-store open. Independent
SQL resources make those parallel definitions a drift source. Initializing a
reference once before user-store access retains that timing constraint while
using the executable SQL as the single structural source.

The resource-copy build step explicitly copies two skill bundles and five owner
SQL directories into matching `dist` paths. SQL directories include only `.sql`
files; skill bundles keep their complete resource trees. The existing package
`files: ["dist"]` rule publishes both. Resource URLs resolve relative to the
owning module in source and installed output, independent of the caller's cwd.
Missing resources fail during module loading. Invalid SQL fails where it is
executed, in reference construction or the real migration transaction; no inline
fallback hides either failure.

The [SQLite design](../../../../docs/design/cli-sqlite-migrations.md#sql-资源与参考结构)
owns the layout and lifecycle, and the
[development guide](../../../../docs/development.md#cli-development) owns build
and installation validation.

## Alternatives

**Keep SQL inline in TypeScript.** This was the initial implementation. It keeps
SQL changes inside TypeScript source and cannot provide independent SQL assets.
Fixed resource URLs preserve explicit ownership and ordering without introducing
runtime discovery.

**Externalize execution SQL but retain duplicate validator DDL.** The expected
layout could diverge from the statements that create or upgrade real databases.
Running the same explicit chain in SQLite supplies its own reference metadata,
including the layout produced by ALTER steps, without a second CREATE model.

**Parse SQL into a separate schema model.** Reconstructing tables, constraints and
indexes adds SQL interpretation solely to keep execution and validation aligned.
SQLite already interprets those statements. Store-specific matching of the
supported finite layouts remains distinct from building a general SQL parser,
schema-diff engine or repair facility.

## Consequences

SQL is independently reviewable and shipped as an explicit runtime resource.
Version registration, native ownership, JSON behavior and all existing data
formats remain unchanged. Baseline and upgrade scripts remain valid as their
registered chain from an empty database, because new database creation already
uses that chain.

Format initialization performs bounded reference work and closes each memory
connection. Later inspections use cached metadata and the existing user-database
snapshot rules. Missing or invalid resources are visible errors at their actual
loading or execution boundary; malformed adoption SQL cannot leave a partial
schema because it runs in the migration transaction.

Package validation must check resource inventory and exact copied bytes, then
exercise the actual installed SQL rather than infer completeness from source
files. Build and resource-copy scripts are release inputs. The existing migration
mechanism still rejects unsupported layouts and retains unknown ownership; SQL
resources do not create a new command, persistence ledger or migration scheduler.
