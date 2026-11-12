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

The persistent APFS identity and Git lock mechanism described below was replaced
by the [manifest adoption decision](../architecture/2026-11-12-worktree-manifest-adoption.md).
The first two paragraphs preserve its original rationale; the remaining coverage
and archive decisions remain active.

The [Worker design](../../../../docs/design/daynight-worker.md) separates worktree ownership, inventory coverage and archive repair conditions.

The original approach used immutable APFS sidecars to bind volume and object
identities to marker bytes and owner. Bootstrap required successful legacy
validation and could not attest a directory after drift. Keeping the marker
unchanged preserved older readers and avoided a two-file identity transaction.
Other platforms retained strict historical identity checks.

Complete discovery can retain a locally attributable invalid resource as a
quarantined claim, preserving the same-task barrier and independently observed execution capacity. Partial enumeration,
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
can become quarantine candidates. Changed ownership or current directory objects,
Git pointers, filesystem reads and unclassified failures retain unknown coverage.
These rechecks retain the controlled-writer assumption, not an
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

The original sidecar scheme required evidence saved before device-number drift.
It did not protect against copied volume identities or same-user concurrent path
replacement. The replacement and its current trade-offs are recorded in the
manifest adoption decision.

Quarantine retains storage and the same-task barrier; confirmed execution stop
releases capacity independently. Unknown execution responsibility or unbounded inventory remains blocking; a
localized repository format gate does not stop independent prepared repositories. Archive
repair probes preserve data and may wait indefinitely when complete source proof
cannot be recovered. Reconstruction, incomplete-archive acceptance and separate
storage quotas are independent designs, not automatic outcomes of a retry.
