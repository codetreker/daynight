# Agent Note: Worker Assistant-Host HTTP Test Owners

Status: implemented

## Problem

The original Worker assistant-host report/detail/list test assembled the complete
application and executed real service and Core operations through DAO mocks to
obtain fixed protocol results. HTTP arguments, output omission, private headers
and log redaction were coupled to unrelated route/MCP construction and lower
business decisions. The same case captured complete snapshots, so removing its
DAO fixture alone would lose validation and projection observations.

The configuration-exchange compatibility case also observes a distinct initial
configuration, future-observation refusal and legacy heartbeat behavior through
that combined boundary. Supplied HTTP results cannot replace its Core and
service observations. Its DAO mocks never proved actual persistence, and an
existing Store legacy check observed only the write's RETURNING value before
reading configuration in a fresh snapshot.

The [root HTTP DAO decision](2026-11-09-root-http-test-dao-ownership.md) removed
real database preparation while retaining application assembly and business
paths. This decision partially supersedes that boundary for the first
assistant-host reporting test and establishes separate compatibility receivers.

## Decision

The strict Worker operation fixture registers actual Worker routes, request
logging and credential middleware. Configurable Report, Get and List callbacks
verify context, principal, canonical Worker ID, complete Report input, default
page arguments and exact calls. Each request releases its callback;
unconfigured operations fail independently. Get and List results are separate
supplied facts, without evolving records from Report calls.

Raw host data retains all providers, states, nullable reason/model fields,
non-null Args and timestamps. The first report's time is captured once for its
independent expected input. Success, all-timeout and absent-host responses retain
complete projections; the extra absent-host GET verifies omission, not JSON
null. The actual logger checks private markers and model names remain absent.
Protocol version 2 reaches Report once and receives a supplied validation fault;
the wire parser accepts the integer, while Core owns that refusal.

Core tests execute actual report validation and snapshot projection over fresh
input and expected values. They compare complete reports, ownership, telemetry,
server/inventory timestamps and explicit empty observed tasks for successful,
all-timeout and absent hosts; otherwise-valid protocol 2 remains invalid input.
Host objects, provider slices, reason/model pointers and Args are independently
allocated without typed-model JSON copying.

Configuration receivers preserve the compatibility case's exact 3/60000/0
bootstrap value, revision-one receipt with observation revision zero and false
acceptance, and base-zero/desired-two observation refusal. Core executes the
actual exchange through strict DAO callbacks. Its supplied current state,
setter result and complete expected receipt are independent facts.

The admission service fixture supplies distinguishable input, normalized,
proposed-snapshot and stored hosts. Complete callback comparisons observe each
transition and the strict DAO receives the independently supplied Core snapshot.
Compatibility cases independently supply bootstrap success, exchange refusal and
legacy reports with no inventory or configuration. False observation acceptance
forbids a configuration read; legacy reports forbid parsing and exchange. Receipt
values, operation failures and transaction completion remain independent. The
[admission decision](2026-11-09-worker-admission-test-owners.md) owns the six
production bindings, refusals and completion precedence.

The existing Store configuration case retains its own capacity data and real
configuration/observation reads. Its legacy heartbeat checks actual committed
completion, the original RETURNING result and a fresh complete Worker snapshot
against independently constructed expected telemetry and timestamps. A fresh
configuration snapshot still verifies that the heartbeat preserved desired and
observed configuration. This fresh Worker read strengthens the physical proof;
it does not relocate persistence from the former HTTP mocks.

The configuration-exchange HTTP compatibility test retains its existing shared
DAO fixture and request sequence. Its eventual protocol isolation is a separate
change; these receivers preserve the lower observations beforehand. Historical
configuration repair, revoked-project access and JSONB readback remain intact.

## Alternatives

**Keep complete application construction and DAO mocks.** This repeats unrelated
registration work and lower business paths while checking HTTP adaptation.

**Replace the wire test without receiving its lower observations.** Supplied
HTTP outcomes cannot prove report validation, projection or configuration
exchange decisions. Core retains those rules; the service fixture verifies
coordination against independent results and refusals.

**Use Report capture to populate later Get or List results.** That turns the
fixture into a stateful storage substitute. Independent read facts expose
transmission behavior without pretending that an operation persisted anything.

**Treat RETURNING as a later persistence observation.** A write result cannot
establish what a separate snapshot reads. The existing Store fixture supports
that observation without another schema or business workflow.

## Consequences

The selected HTTP, Core and admission service proofs execute without database or
UniAuth fixtures. Native parsing, encoding and logging remain real. The separate
configuration compatibility HTTP case retains its existing fixture requirements.
Store retains actual SQL, completion, rollback and fresh persisted observations.

Source-bound comparisons include receiving Core, Service and Store costs. Added
receivers can increase those costs before protocol migration; fewer upper-layer
fixtures and faster hosted CI are not consequences of this prerequisite alone.
Matched faults distinguish wrong bootstrap values, future observations, extra
configuration calls and lost refusal chains at their responsible owners. Store
faults separately verify host replacement and unchanged configuration.
