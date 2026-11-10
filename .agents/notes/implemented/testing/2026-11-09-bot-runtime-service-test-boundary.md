# Agent Note: Bot Runtime Service Test Boundary

Status: implemented

## Problem

Runtime tests prepared a real identity, Worker, Bot and registered Session through
PostgreSQL and lower services to observe credential checks and callback order.
That setup made the orchestration tests depend on core authorization, Engine
state and storage behavior. Removing the database alone would still run those
lower decisions, and removing their assertions would lose parent revocation and
stopped-operation admission proofs.

## Decision

Runtime holds private, instance-owned core operation functions. `NewRuntime`
binds Engine admission, Operation close/credential/binding/load/owner calls,
Bot authorization and Access authority to their production implementations.
The public Runtime and callback contracts retain their Operation and Access
identities. Unit fixtures supply those opaque values and independent domain
facts, errors and exact call plans; they do not simulate an Engine or Store.

The real `Run` body executes the writer callback, PAT admission, current
credential checks, Bot read, authorization, prepare/check callbacks, parent
credential check and work/recheck callback. Tests observe the same context,
transaction scope, inputs, tokens and required order. Lower refusals preserve
the original error and prevent subsequent work. Operation admission failures do
not acquire a writer, and admitted operations close exactly once.

The Session service retains its actual transaction callback and
`Operation.Finish` binding. The production Runtime constructor test checks its
default operation bindings, Engine receiver and admitted-operation lifetime.
The service test supplies the runner result; it does not claim that callback
execution or a mock outcome committed data. The
[Bot expiry HTTP decision](2026-11-10-bot-expiry-http-test-owners.md) records
the corresponding HTTP and registration proof owners.

The existing core Bot authorization test owns deleted/foreign Bot decisions.
The existing Engine stop test checks the precise `service_unavailable` admission
fault. Core Session tests own parent-credential authorization. The existing
PostgreSQL Session cleanup case supplies a registered parent PAT and a distinct
current PAT, reads the inserted Bot/parent association before a grant can
overwrite it, then checks the live connection association. It physically removes
the parent and verifies the current remains valid while the parent credential read
fails. Its grant, ledger, revocation, corrupt-data, rollback, cleanup and
redaction assertions remain with the actual DAO and transaction mechanism.

The [Go dependency policy decision](2026-11-08-go-test-dependency-boundaries.md)
owns the common direct-operation rule. This decision applies it to Runtime
without changing production authorization, lock order or lifecycle behavior.

## Alternatives

**DAO mocks beneath real core operations.** These remove PostgreSQL preparation
but retain core decisions and Engine state inside the orchestration test, so a
core change can fail a service proof for an unrelated reason.

**A forwarding core adapter implementation.** The operations already accept the
concrete identity tokens exposed by Runtime callbacks. A second adapter type
would add forwarding methods around those calls without owning another behavior.
Instance operation functions expose the actual dependency capabilities directly.

**Global operation substitutions.** Shared mutable bindings couple fixtures and
concurrent consumers. Instance bindings keep the tested call plan private to its
Runtime and leave production constructors bound to the real implementations.

## Consequences

Runtime tests execute their orchestration without database or authentication
fixture preparation. Rule, credential persistence and Engine lifetime proofs
remain in their owning tests rather than disappearing behind static outcomes.
The private bindings add explicit dependency slots; constructor consumer coverage
and strict unexpected-call failures are needed to keep those slots correctly
connected.

Performance results belong to source-bound task evidence. Package feedback
improvement must be assessed with receiving Core/Store tests and full validation;
it does not establish an equal reduction in hosted CI completion time.
