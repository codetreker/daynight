# Agent Note: Controller capacity-free format upgrades

Status: implemented

## Problem

A historical Controller journal can exceed ordinary write budgets or a physical
space estimate even when its format conversion can actually be written. Applying
those limits during conversion or immediately afterwards prevents observing the
original execution, including recording its stop.

## Decision

Numbered journal conversion and historical export and import use the original
storage permit and real SQL and file publication operations without capacity
reservations or ordinary write limits. A pure upgrade returns the actual version
and cleanup flag without loading a business snapshot or settling maintenance
admission. Reads of converted content do not reject it solely for exceeding a
new-write limit. Stored reads and conversion select a capacity policy in the
existing parsers rather than maintaining a separate persistent codec; ordinary
protocol input retains the strict policy. Real storage and transaction failures
remain visible.

The subsequent [metadata admission removal](../simplification/2026-11-16-controller-metadata-admission-removal.md) removes cumulative metadata admission
from ordinary writes and stopped maintenance. The
[media ledger removal](../simplification/2026-11-16-controller-media-ledger-removal.md)
separately removes cumulative media reservations from those paths; the later
[free-space and peak admission removal](../simplification/2026-11-16-controller-free-space-admission-removal.md)
removes their disk predictions. The [storage
ownership](2026-11-12-controller-storage-ownership.md) and [SQL content
components](2026-11-12-session-sqlite-content-components.md) decisions retain
the permit and maintenance ordering; this decision replaces their
conversion-time reservation. The [content
design](../../../../docs/design/session-sqlite-content.md) owns the current
mechanics.

## Alternatives

**Reserve the estimated conversion peak.** This protects ordinary capacity
budgets but can reject an otherwise writable old journal, preventing a stop
observation. Estimates cannot establish whether the actual write will fail.

**Increase the limits.** A larger fixed threshold still rejects sufficiently
large valid history and couples format compatibility to business admission.

## Consequences

Conversion can consume available storage and fails on actual SQL or filesystem
errors. Successful conversion does not imply maintenance or a new writer is
admitted. The existing format mapping and source checks remain separate from
this capacity decision.
