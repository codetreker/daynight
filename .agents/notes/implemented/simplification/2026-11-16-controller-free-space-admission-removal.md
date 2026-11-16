# Agent Note: Remove Controller free-space and future-peak admission

Status: implemented

## Problem

A Controller operation can be rejected by an estimated future disk peak or the
512 MiB free-space watermark even when its actual file and SQLite writes would
succeed. Retained source copies, wire spools and VACUUM estimates add predictive
accounting to unrelated media lifecycle and maintenance responsibilities. Such
estimates cannot reserve storage against concurrent filesystem users or establish
that a particular write will fail.

## Decision

Controller preparation, media upload and sealing, history synchronization and
stopped maintenance do not query remaining volume space or reserve estimated
future disk growth. Free-space errors, peak-reservation objects, prediction-only
media scans, unwritten byte maps and wire-growth callbacks are removed. Actual
filesystem and SQLite operations determine whether work can complete; ENOSPC,
permission, write, commit and close errors retain their original known or unknown
outcome semantics.

The remaining capacity owner applies the existing metadata policy: 128 MiB of
ordinary control metadata, 8 MiB of settlement headroom, real SQLite sidecars and
pending metadata, with the original committed timeline and matching active
history-file allowances. A `physical_capacity` wait can arise only from this
metadata policy. Single-image, message and archive limits, protocol validation,
decoder memory and concurrency limits, and outbox backpressure retain their
independent owners.

Stopped maintenance executes directly under its original storage permit. Reader
barriers, recognized legacy-source identity and retirement, checkpoints,
synchronous in-place VACUUM, physical file verification, pending-marker commit
and committed readback retain their ordering. VACUUM still uses a checked private
temporary directory on the original journal volume and restores the exact prior
environment after success or failure. Failed work retains its actual phase and
cleanup responsibility.

Media lifecycle records retain their original capture, attempt, source, stage and
released identities. Writer joining, source and resource leases, immutable
originals, private-path and symlink checks, durable deletion and slot return after
confirmed cleanup remain independent of capacity prediction. Removing directory
scans does not replace the identity checks at the operations that open, publish
or retire those files.

This decision partially supersedes the free-space and peak policies in the
[source](../architecture/2026-11-05-session-image-sources.md),
[Provider](../architecture/2026-11-05-session-image-providers.md),
[unified media](../architecture/2026-11-09-unified-session-media-core.md),
[resource-file](../architecture/2026-11-12-session-resource-files.md),
[SQL content](../architecture/2026-11-12-session-sqlite-content-components.md),
[SQL activation](../architecture/2026-11-12-session-sqlite-activation.md),
[storage ownership](../architecture/2026-11-12-controller-storage-ownership.md),
[capacity-free conversion](../architecture/2026-11-16-controller-capacity-free-upgrades.md)
and [media ledger removal](2026-11-16-controller-media-ledger-removal.md)
decisions. Their original ownership, reader safety and durability rationale
remains applicable. The [service content policy](../architecture/2026-11-13-session-actual-content-capacity.md)
is independent. The [current storage design](../../../../docs/design/session-sqlite-content.md)
and [media contract](../../../../docs/design/session-image-contracts.md#controller-准入与回收)
own the remaining interfaces and limits.

## Alternatives

**Retain or raise the free-space watermark and peak estimates.** Any finite
estimate can still refuse an otherwise successful write, while another process
can consume space immediately after the check. It preserves prediction-only
scans and callbacks without establishing the actual write outcome.

**Keep unlimited or no-op reservation objects.** This retains misleading capacity
interfaces and lifecycle coupling after their admission policy is removed. Direct
execution under the existing permit preserves ownership without those objects.

## Consequences

Controller operations may consume the remaining volume space and fail during
real IO. Recovery must preserve the original source, committed phase and unknown
outcome evidence; there is no predictive guarantee that later writes or cleanup
will succeed. Low reported free space alone cannot prevent otherwise valid work.

Media directory scans and future-byte bookkeeping no longer run solely for
capacity prediction. Metadata measurement and its existing identity checks remain
necessary for the retained metadata policy. No journal format migration, new
configuration switch or stale-budget compatibility path is introduced.
