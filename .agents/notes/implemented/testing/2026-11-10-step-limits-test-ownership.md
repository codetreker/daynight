# Agent Note: Step Limits Test Ownership

Status: implemented

## Problem

Step text and collection limit tests combined business admission, production
encoding and service transaction coordination. Repeated encoding of the same
large collection made the service suite expensive and obscured which layer
owned each failure.

## Decision

The [application retirement](../simplification/2026-11-23-retire-task-steps-application.md) removes the Step
capacity rules, codec and dedicated tests. The following preserves the original
capacity-test ownership; retained PostgreSQL code keeps its physical witnesses.

The original Core tests exercised text inputs through Add and Change admission
and real encoding. One collection witness encoded 170 complete descriptions,
then admitted and encoded a 171-description Change through the actual capacity
gate and error conversion. It also checked the complete 172-row Add candidate.
Service tests controlled admission while checking full input and collection
forwarding, and used a real timestamp encoding failure to verify suppression
before writes. Transaction completion remained independent of callback results.
The [earlier service ownership decision](2026-11-08-task-service-test-ownership.md)
records the original combined proof; the [content write decision](2026-11-10-step-content-write-coordination-tests.md)
owns the shared operation boundary.

## Alternatives

**Repeat large encoding through both public methods.** This retains redundant
work at a layer that does not own the capacity decision and couples coordination
feedback to the lower rule.

**Replace the capacity failure with a synthetic error.** That would not prove
the real encoded bytes, capacity gate or conversion into the public fault.

## Consequences

The real capacity witness and service coordination jointly retained the relevant
failure signal without treating controlled writes as database persistence.
PostgreSQL tests remain responsible for physical transaction behavior. Runtime
comparisons must include the receiving Core tests under matching conditions and
do not alone establish a hosted CI speedup.
