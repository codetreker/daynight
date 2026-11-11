# Agent Note: Recover Worker resources from explicit identity and coverage evidence

Status: implemented

## Problem

A mount device number can change after a normal machine restart while the original
repository and task directories remain intact. Persisting device/inode pairs as
mandatory identity evidence makes that environmental change indistinguishable
from replacement. A single failing managed registration can then invalidate a
whole inventory and prevent unrelated acquisitions. Separately, a known
incomplete archive cannot become complete by repeating the same content scan and
upload attempt.

## Decision

The [Worker design](../../../../docs/design/daynight-worker.md) separates stable
worktree identity, inventory coverage and archive repair conditions.

On supported macOS APFS, immutable sidecars bind persistent volume and object
identities to the original marker bytes and owner. Bootstrap requires successful
legacy validation; it cannot retroactively attest a directory after drift.
Keeping the marker unchanged preserves older readers' discovery and avoids a
two-file identity update transaction. Current object checks and Git attribution
still guard every mutation. Unsupported platforms retain strict legacy checks.

Complete discovery can retain a locally attributable invalid resource as a
quarantined claim, with capacity and same-task fencing intact. Partial enumeration,
unknown ownership or conflicting identities still prevent new acquisition.
Registration uniqueness compares physical targets, including manual registrations
and aliases. Forward, reverse and common-directory pointers require
platform-specific traversal proof before canonical comparison. POSIX passes the
original path to the filesystem without lexical normalization. On Windows, Node
normalizes paths before opening them, so each directory cursor removed by a `..`
component must first be observed with `lstat` as an existing ordinary directory.
A junction, symlink, missing component, non-directory or I/O failure leaves
coverage unknown. Ordinary relative paths remain admissible when those checks
succeed; passing the raw string alone cannot preserve Windows traversal semantics.
Parent traversal through missing components remains unknown. Only explicitly
classified static, resource-local validation failures under stable observations
can become quarantine candidates. A mismatch against historical identity evidence
does not imply that observations changed during inspection. Observed changes to
owner, marker or sidecar metadata, current directory objects or Git pointers retain
unknown coverage instead of attributing the resource to its indexed owner. Before
accepting an early branch or sidecar validation failure, the scan still reads the
locked marker stably and checks it against the index; changed, missing or
unconfirmed marker evidence cannot hide a new owner conflict. Filesystem reads,
native queries, response parsing and otherwise unclassified failures also retain
unknown coverage. These rechecks retain the controlled-writer assumption, not an
atomic snapshot guarantee against malicious same-user replacement. Mapping
admission does not grant resource ownership. Strict readers used by cleanup cannot
omit invalid records and infer absence.

Typed archive completeness blockers persist with their cleanup owner and a
15-minute condition-probe schedule. Probes preserve original stopped-generation
and receipt reconciliation. A confirmed complete source clears its persisted
repair classification before full archival, restoring ordinary transient retry
policy if upload fails. Receipt presence and legacy-schema admission do not prove
that the source was repaired. Clearing classification must succeed durably before
its in-memory counterpart changes; neither operation releases cleanup responsibility.
Only successful complete cleanup releases resource ownership. The [execution capacity decision](../architecture/2026-11-11-worker-execution-capacity.md) separates a confirmed stopped execution from retained cleanup responsibilities. This narrows the retry policy described in the immutable
[cleanup retry decision](../../archived/bug-fix/2026-11-04-worker-cleanup-retry.md),
whose bounded retry and per-claim fairness remain appropriate for transient and
unclassified failures.

## Alternatives

**Ignore device numbers or rewrite every marker.** This would recover the observed
restart quickly but could adopt a replaced volume or directory without historical
identity evidence. It would also weaken destructive cleanup authorization.

**Extend the existing marker.** Older strict readers can skip unrecognized
formats, causing retained resources to disappear from their capacity view. An
immutable companion record leaves their marker parser and fail-closed behavior
intact.

**Keep global blocking for every bad item.** This conservatively protects capacity
when enumeration is incomplete. Applying it to a fully observed and independently
attributed single claim unnecessarily stops healthy work; quarantine preserves
its reservation without treating validation failure as absence.

**Infer local validation from the absence of a familiar error code.** Native
queries can report numeric errno codes, and response parsing or wrapped I/O can
have no code. A negative error-name filter would treat incomplete observation as
safe quarantine. Explicit validation errors keep that decision with the code
that actually observed the violated condition.

**Retry every archive failure identically.** Exponential backoff bounds frequency
but repeatedly scans unchanged incomplete sources. A typed, durable blocker allows
cheap condition checks without pretending missing data has been recovered.

## Consequences

Normal device-number drift can recover only after stable evidence has been saved.
Legacy records already affected by drift remain explicitly blocked. Complete
volume clones can reproduce the evidence, and same-user concurrent path replacement
is outside the controlled-writer assumption; the sidecar is not an anti-cloning
or sandbox mechanism.

Quarantine retains capacity and storage. Unknown inventories remain globally
blocking because historical counts do not prove a present upper bound. Archive
repair probes preserve data and may wait indefinitely when complete source proof
cannot be recovered. Reconstruction, incomplete-archive acceptance and separate
storage quotas are independent designs, not automatic outcomes of a retry.
