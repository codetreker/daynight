# Agent Note: Limit Controller upgrades to local format mappings

Status: implemented

## Problem

Historical journal upgrades must replace storage formats even when unrelated
business fields or associations contain bad values. Treating every historical
record as a healthy runtime object makes one bad item prevent other independent
items and the database format from advancing. File writes also cannot be rolled
back by SQLite, so the original committed sources remain necessary for retry.

## Decision

The v6, v8 and v10 steps select sources from SQL rows or committed pointers and
perform only the operations needed to form their target representation. They
publish files durably before switching SQL authority, preserve original external
sources on failure, and derive target pointers and totals from actual output.
When an item cannot be represented, only that item is skipped. Actual SQL and
filesystem errors propagate. The [content design](../../../../docs/design/session-sqlite-content.md)
owns the mapping and reentry details.

The v12 step maps only changed capture state fields. It preserves an inoperable
state and unrelated receipts and image associations without validating complete
business records. The existing runtime consumers retain their own validation and
recovery rules.

This changes the original strict historical source validation in the
[atomic publication decision](2026-11-10-atomic-content-publication.md) while
retaining its SQL visibility and reader-lifetime guarantees. The
[SQL components decision](2026-11-12-session-sqlite-content-components.md)
continues to own the current body store and stopped maintenance.

## Alternatives

**Validate and repair all historical business data during upgrade.** This makes
format availability depend on unrelated messages, receipts and associations, and
requires inventing recovery facts where the source is inconsistent.

**Record loss markers or add a new recovery protocol.** Durable markers and
runtime branches would introduce another format and ongoing consumer obligations
without making an unrepresentable source value mappable.

## Consequences

Independent representable items can advance even when another item cannot.
The current format may retain bad values, and ordinary readers can reject them;
a successful upgrade does not establish complete or healthy business history.
The original external files are not cleaned or repaired by this conversion.
Stopped maintenance retains a valid `prepared` backup from an interrupted old
export without rewriting its marker, an empty backup directory without a marker,
and interrupted publication temporary files. Completed backups keep their existing
retirement path. Retained bytes remain part of actual storage accounting.
