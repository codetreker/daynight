# Agent Note: Worker Assistant-Host HTTP Test Owners

Status: implemented

## Problem

The Worker assistant-host report/detail/list test assembles the complete
application and executes real service and Core operations through DAO mocks to
obtain fixed protocol results. HTTP arguments, output omission, private headers
and log redaction are therefore coupled to unrelated route/MCP construction and
lower business decisions. The same case captures complete snapshots, so removing
its DAO fixture alone would lose validation and projection observations.

The [root HTTP DAO decision](2026-11-09-root-http-test-dao-ownership.md) removed
real database preparation while retaining application assembly and business
paths. This decision partially supersedes that boundary for the first
assistant-host reporting test.

## Decision

The existing strict Worker operation fixture registers actual Worker routes,
request logging and credential middleware. Configurable Report, Get and List
callbacks verify context, principal, canonical Worker ID, complete Report input,
default page arguments and exact calls. Each request releases its callback;
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

The existing admission service fixture supplies distinguishable input,
normalized, proposed-snapshot and stored hosts. Complete callback comparisons
observe each transition and the strict DAO receives the independently supplied
Core snapshot. The [admission decision](2026-11-09-worker-admission-test-owners.md)
owns those six production bindings, refusals and completion precedence.

The configuration-exchange compatibility test retains its existing shared DAO
fixture and separate business observations. This change corrects the first
report/read test and preserves its original request sequence.

## Alternatives

**Keep complete application construction and DAO mocks.** This repeats unrelated
registration work and lower business paths while checking HTTP adaptation.

**Replace the wire test without receiving its complete snapshot observations.**
Supplied HTTP outcomes cannot prove actual report validation or projection.
Core retains those rules; the service fixture retains normalized-to-snapshot
argument propagation with distinguishable host facts.

**Use Report capture to populate later Get or List results.** That turns the
fixture into a stateful storage substitute. Independent read facts expose
transmission behavior without pretending that an operation persisted anything.

## Consequences

The selected HTTP, Core and admission service proofs execute without database or
UniAuth fixtures. Native parsing, encoding and logging remain real. The separate
configuration compatibility case retains its existing fixture requirements.

Source-bound comparisons include the receiving Core and Service costs and the
complete Root server package. Package timings and a cheaper isolated case do
not establish faster hosted CI. Matched faults distinguish truncated wire Args,
lost Core host projection and lost normalized service input at their owners.
