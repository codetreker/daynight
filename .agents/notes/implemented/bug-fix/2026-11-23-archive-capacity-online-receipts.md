# Agent Note: Preserve Online Receipts Until Archive Publication

Status: implemented

## Problem

Final history can fit the content budget while its manifest makes the complete
archive exceed it. Retiring online-only image references at history completion
would then invalidate an accepted upload receipt and its original even though
the archive was never published. A confirmed streaming file failure also needs
to remain distinguishable from an unknown outcome or corrupt staging.

## Decision

Stopped history retains the eligible online occurrences in the archive ledger.
The ready transaction checks the final closure and combined capacity, rechecks
read leases, and retires eligible references atomically with publication. Body
resources and other references remain protected. The same boundary applies to
both history upload versions and to active and relay-mode inventories.
After the archive lease is released, the Server attempts upload reclamation;
the ordinary Web Task archive maintenance pass retries released uploads from
durable state with the original identity, reference and lease checks. Cleanup
failure does not change a committed ready receipt.

The Controller preserves the code and message of an identity-checked terminal
file receipt. Only confirmed staging corruption permits a successor. Worker
monitoring maps confirmed `quota_exceeded` to a fixed diagnostic instead of
copying arbitrary server text. The [archive design](../../../../docs/design/session-image-archives.md)
owns the resulting contracts. This refines the stopped archive closure in the
[online relay decision](../architecture/2026-11-23-session-online-relay.md)
and terminal receipt handling in the [streaming decision](../architecture/2026-11-23-archive-streaming-upload.md).

## Alternatives

**Retire after history validation.** This makes online originals unavailable
before the manifest and combined capacity are known to succeed.

**Report every terminal failure as an unknown error.** This discards the
confirmed capacity reason and makes a durable failure indistinguishable from
an uncertain transfer.

## Consequences

Failed or rolled-back publication retains online receipts and originals. The
ledger carries pending occurrences until publication, and a reader can delay
ready until its lease is released. Physical reclamation can lag publication
and resumes on maintenance passes after failure or restart. Monitoring exposes
the capacity reason without publishing server-supplied diagnostic text.
