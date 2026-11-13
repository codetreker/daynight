# Agent Note: Measure accepted Session content at publication

Status: implemented

## Problem

A fixed future-space reservation for every Session can exhaust admission even
when current content and actual disk space would permit a write. Declared image
lengths and display pages do not establish the size of accepted full history.
Publication also crosses file and database boundaries, so concurrent writers and
unknown commits cannot be resolved by a speculative reservation.

## Decision

The Session core measures the complete timeline, its canonical entry and
occurrence index, distinct available resource originals, their canonical sorted
descriptors and an actually published manifest against one 128 MiB limit. It
reuses the existing ledger and resources instead of a separate total cache.
Each final short transaction holds the Session lock, reads the latest facts and
checks its measured candidate before saving the publication and receipt. Full
history is authoritative; a display page or unsynchronized Controller text is
not a complete measurement. Same-epoch advancement prevents an older checkpoint
from replacing newer content. File publication and database unknown outcomes
retain their original identity and cleanup responsibility.

The legacy prepare and register paths preserve authorization, identity, source
and lifecycle checks without reserving future bytes or slots. Their seven-field
image budget remains parseable with zero reserved values; it is not the new
writer policy. Schema3 native timeline and history transport allow 128 MiB and
128 MiB plus 16 KiB respectively, while schema1/2 retain their old limits.
Existing large records remain readable and confirmed replays do not pay twice.
The [archive design](../../../../docs/design/session-image-archives.md#容量预算与准入)
owns the exact accounting and publication contract.

This replaces the service reservation assumptions in the earlier [unified
media](2026-11-09-unified-session-media-core.md), [image
archive](2026-11-05-session-image-archives.md) and [image protocol](2026-11-05-session-image-contracts.md)
decisions; their original identity, source, reference and recovery rationale
remains applicable.

## Alternatives

**Keep global future reservations or change the safety watermark.** Both make
admission depend on capacity that content has not consumed, and continue to
multiply a fixed archive allowance by historical Session count.

**Maintain another total or per-writer delta ledger.** It duplicates facts and
requires reconciliation across resource, history and manifest publication;
measuring existing authoritative facts under the Session lock avoids drift.

**Count display entries or declared upload lengths.** Display output can be
truncated and declarations are not verified bytes, so neither proves the
complete content being accepted.

## Consequences

Each publication reads current facts and measures canonical metadata, trading
some short-transaction work for a single source of truth. Temporary files and
control records do not consume logical content capacity but remain subject to
real storage failures and their original cleanup barriers. Compatibility
receipts do not promise that later writes will succeed. Controller-local media
and physical limits remain independent of the service's content policy.
