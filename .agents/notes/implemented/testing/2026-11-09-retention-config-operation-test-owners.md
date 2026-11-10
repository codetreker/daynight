# Agent Note: Retention Configuration Operation Test Owners

Status: implemented

## Problem

Retention service tests execute the real configuration collector through DAO
mocks to obtain eligibility and affected-row results. Referenced, active,
missing and unexpired candidates, snapshot barriers and per-candidate counts
belong to Core. Repeating those decisions obscures whether a failure concerns
collection rules or Retention's shared budget, context and lifetime.

The earlier DAO isolation removed database preparation from these service tests.
It retained the production collectors so their cached scans and unknown outcomes
remained observable. A direct operation boundary must preserve that state and
receive the rule observations before removing the combined fixtures.

## Decision

Retention consumes a private configuration collector interface with Reconcile
and Pass operations. Its constructor binds one stateful Core collector pointer;
both methods and every activation share that instance. Production ordering,
two-second deadline, category rotation, 500-row budget and 125-row category quota
remain unchanged. No per-call reconstruction or nil fallback is introduced.

The existing [configuration collection plan](2026-11-09-webhook-config-gc-test-owners.md)
receives the original five candidate rules, pending barrier and complete 125-item
configuration work. It checks full context, scan cursor, limit, barrier,
candidate identity, required order and consumed calls. Callback execution and
completion remain independent supplied facts. The 125-item identity, order and
context checks strengthen the former service fixture, which observed its count.

Selected service tests supply independent zero, one and 125-row operation results
through strict Reconcile and Pass callbacks. They check the same derived context,
actual Store identity, exact quota and call sequence; unconfigured or extra calls
fail independently, and cleanup verifies complete consumption. Configuration DAO
callbacks remain unconfigured in these tests. The original correction retained
125 native receipt operations and 250 history callbacks; the later
[collector ownership decision](2026-11-10-retention-collector-operation-test-owners.md)
receives Receipt rules and replaces the service receipt work with controlled
operations while retaining real history callbacks.

Internal-budget expiry, later history progress, single-flight admission and
production deadline checks block the controlled operation while retaining real
passMu, cancellation, observation and drain. The blocked pass has bounded cleanup
on every test exit. Constructor checks verify the native collector binding before
selecting the controlled operation.

The initial correction retained native configuration unknown helpers and their
lifecycle consumers because receiving state bridges were outside its selected
scope. The later [collector ownership decision](2026-11-10-retention-collector-operation-test-owners.md)
separates those operations after receiving the actual Core state transitions.
History scopes, locked clock sampling, transaction completion and real Start/Stop
synchronization remain with their mechanism owners.

## Alternatives

**Keep all configuration decisions behind service DAO mocks.** This avoids a
consumer interface but repeats Core rule execution and candidate setup when the
service only needs an affected-row result.

**Construct a collector for each activation or each operation.** That discards
cached barriers and uncertain identities. Successful method calls would no
longer establish readback before later maintenance writes.

**Replace the unknown and lifecycle cases with fixed results too.** At the time
of this correction, those cases observed retained native state and background
resource lifetime. Isolation required receiving state proofs beyond the selected
rule and budget correction; the later collector decision provides those bridges
and finite operation plans.

## Consequences

The selected Core and service proofs execute without database or UniAuth
fixtures. Core owns eligibility, barrier admission and confirmed configuration
counts; service owns aggregation, quotas, timing, observations and single-flight
coordination. Supplied completion remains distinct from SQL persistence.

Comparisons include receiving Core cases and both complete owning packages.
Moving 125 candidate operations does not establish a stable runtime or hosted CI
improvement. Matched faults distinguish preserved count/rule detection from newly
precise call constraints. The later collector decision receives the original
native unknown-state witnesses in Core while keeping service synchronization
and operation ordering explicit.
