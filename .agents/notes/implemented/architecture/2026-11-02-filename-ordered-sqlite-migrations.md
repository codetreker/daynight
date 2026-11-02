# Agent Note: Filename-Ordered SQLite Migrations

Status: implemented

## Problem

Independent SQL files and a separate TypeScript step list give migration order two
representations. Adding a numbered SQL file can leave it packaged but inactive
until another source file is updated. Source/adoption SQL also needs a distinct
role: placing it beside ordinary upgrades risks treating reference construction
or a conditional conversion as an unconditional migration.

## Decision

Each owner selects one main-chain directory. The loader discovers top-level
names ending in `.sql` case-insensitively, then requires each candidate to be a
regular file with valid lowercase naming. Unrelated non-SQL entries and ordinary
auxiliary directories are ignored. Valid SQL filenames are sorted lexically and
their numeric prefixes supply versions. The first file is the baseline; every
following version must be exactly the preceding value plus one. The target is
the discovered last version. No per-step TypeScript registry, manifest or second
order participates. Adding a valid next numbered file therefore adds that
migration automatically.

Names use `NNN-description.sql`: at least three decimal prefix digits, equal
zero-padding width within a directory, a positive signed 32-bit version and a
lowercase ASCII letter-led alphanumeric slug with optional hyphen-separated
segments, with a lowercase `.sql` extension. Missing directories, empty SQL
chains, malformed or non-regular SQL candidates, duplicate versions, inconsistent
padding and interior gaps are errors. An uppercase `.SQL` file or SQL-named
directory is rejected as a candidate; `README.txt`, `.DS_Store` and ordinary
auxiliary directories are outside discovery. A baseline need not start at 1;
Worker retains `005-baseline.sql` and version 5.

Worker's `sources/000-six-column.sql` supplies only a known-source reference, and
`adoptions/005-six-column.sql` runs only after its conditional source admission.
Non-SQL entries and ordinary auxiliary subdirectories do not enter the chain.
TypeScript retains domain selection, JSON transforms and ownership checks, without
supplying another
ordinary SQL execution order.

The [SQL resource decision](2026-11-02-sqlite-sql-resources.md) still owns resource
loading, reference metadata and packaging. It initially used fixed file URLs and
explicit versions to make ordering visible and exclude auxiliary SQL. Filename
authority replaces only that order registration, while dedicated auxiliary
directories retain the exclusion. Per-store formats, `user_version`, snapshot
consistency, transactional conversion and process/lease responsibilities remain
with the [migration decision](2026-10-30-cli-sqlite-migrations.md).

## Alternatives

**Keep an explicit TypeScript step registry.** The original resource design made
all selected versions and files visible in code. It also kept file addition from
being sufficient to add a migration, and could disagree with the order expressed
by numbered filenames. Filename-derived execution makes that order authoritative
without another list to synchronize.

**Scan a mixed root containing upgrades, references and adoptions.** An ordinary
filename sequence could execute a source-only CREATE layout or conditional
Worker adoption as if every database needed it. Auxiliary subdirectories preserve
the distinct roles without another file-order registry.

## Consequences

Runtime execution and cached reference schemas use the same discovered chain.
The resource-copy build step still recursively publishes the five owner SQL
directories; its directory allowlist controls package scope, not migration order.
Installed-resource checks compare the complete actual source tree and bytes.

Without a manifest or second expected sequence, a continuous directory cannot
reveal whether an intended final file is absent. The loader detects empty or
broken discovered sequences, not arbitrary missing tails; its target comes from
the last file actually present. Published source files and package completeness
remain review and installation-validation responsibilities.

Data layouts and version numbers do not change merely because file names become
authoritative. No user-database marker, SQL parser, schema-diff engine or hidden
replacement registry participates in filename selection or ordering. Invalid SQL still fails at its actual
reference or migration execution boundary, and existing rollback and ownership rules apply.
