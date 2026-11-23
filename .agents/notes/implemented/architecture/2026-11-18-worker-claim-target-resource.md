# Agent Note: Transaction-bound Worker claim target resource

Status: implemented

## Problem

A Project write that depends on a Worker's current desired target needs to keep
that fact stable until its own transaction completes. Reading through an
independent Worker transaction would release protection too early. A missing
Worker row cannot be row-locked, and an unrelated malformed application
observation must not prevent reading the authoritative target.

## Decision

`ProjectWriteScope` exposes a narrow `WorkerClaimAdmissionDAO` bound to the same
PostgreSQL transaction. It returns the desired Raw, revision and update time
without interpreting typed configuration or observation, or projecting the
separate archive setting.
Only an absent Worker or uninitialized target returns nil; storage and cancellation
errors remain errors. The [Raw target decision](2026-11-17-worker-raw-desired-configuration.md)
continues to own the authoritative representation.

The resource locks an existing Worker row through Project transaction completion.
After an absent-row read, it acquires the report's existing account admission
transaction lock and reads again in a separate Read Committed statement. The
shared helper keeps both users on the same canonical lock key. An absent row
therefore remains protected from first-report insertion until commit or rollback.
Existing-row reads do not acquire the account lock. The [configuration design](../../../../docs/design/daynight-worker-configuration.md#项目事务内的目标读取资源)
owns the complete resource and lock-order contract.

## Alternatives

**Reuse the complete Worker configuration scanner.** That scanner also decodes
application observations and projects the whole current configuration type.
Neither is required to obtain the target, and unrelated decoding failures would
couple admission to application feedback.

**Read in a separate Worker transaction.** A concurrent configuration save could
commit after the read and before the enclosing Project write commits, invalidating
the fact used by that write.

**Return nil immediately for a missing row.** A first report could insert and
initialize the target before the Project transaction commits. Reusing the existing
admission lock protects this gap without a new lock namespace or persistent row.

## Consequences

Target reads and configuration writes share the actual database row lock and its
transaction lifetime. Only missing-row reads incur account-wide report contention;
normal reads retain independent Worker concurrency. Report transactions remain
independent as described by the [Worker boundaries](2026-11-05-server-worker-boundaries.md),
and the [active admission decision](2026-11-07-worker-active-admission.md) still owns
report capacity rules. This resource supplies storage facts; its consumers own
claim eligibility and field interpretation. PostgreSQL tests own real lock,
fresh-read, cancellation and release proofs, while the Project scope test owns
same-transaction binding.
