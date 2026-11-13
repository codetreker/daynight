# Agent Note: Journal Version Observation

Status: implemented

## Problem

Controller journal admission, stopped settlement, and maintenance reported a
fixed current version. Generic migrations were labeled as timeline imports,
although the numbered journal sequence also contains other changes. These
observations can misstate the target and obscure the actual operation when the
format advances.

## Decision

Admission and maintenance derive the current target from the canonical journal
format. Stopped settlement retains the original source until opening succeeds,
then observes the version of the admitted connection. Generic migration reports
use `journal-migration` and preserve the underlying SQLite phase. Timeline
retirement, compaction, and admission retain their distinct phases. At adoption this did not change the format or historical 010 migration;
[v11 outbox accounting](2026-11-13-outbox-byte-accounting.md) subsequently
uses the canonical target and the same reporting. The
[content design](../../../../docs/design/session-sqlite-content.md) owns the
operational details.

## Alternatives

**Keep per-caller version constants and the import label.** Each format upgrade
would require coordinated diagnostic changes, and unrelated migrations would
continue to appear as content imports.

**Treat the desired target as admitted before opening returns.** A failed or
unknown migration commit would then be reported as a successful format change.

## Consequences

Reports follow the canonical sequence without a separate version setting and
preserve the distinction between an observed source and an admitted connection.
The generic phase name changes for consumers of diagnostic records; the original
SQLite phase and transaction outcome remain available. At adoption this decision
did not introduce a new journal format or outbox accounting.
