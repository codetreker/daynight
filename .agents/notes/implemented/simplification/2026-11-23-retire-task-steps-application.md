# Agent Note: Retire Task Steps Application Logic

Status: implemented

## Problem

Once the REST and MCP interfaces retire, Task Steps still has callable legacy
and scoped application services, dedicated domain candidates, collection encoding
and input-policy entries. Retaining those owners keeps an unsupported business
capability assembled in production. PostgreSQL still implements Step methods and
depends on their model and interface signatures, so application removal must keep
ordinary Task, Thread, synchronization and transaction behavior intact.

## Decision

Application has no TaskSteps operation port, field or constructor, and its scoped
assembly has no Steps service. The Task Steps service, candidate package,
dedicated codec and four step.* input-policy entries are removed with their
tests. The independent Thread codec, ordinary Task text policy, shared errors,
TaskHeader and TouchTask retain their existing consumers.

At this decision, PostgreSQL reader/writer contracts, signature-dependent models,
DAO code and tests, migration 030 and persisted rows remained with storage. The
[storage retirement](2026-11-23-retire-task-steps-storage.md) subsequently removes
the Steps contracts and code while preserving the table. No replacement
service or compatibility adapter occupies the removed application fields.
The separate [credential-choice retirement](2026-11-23-retire-step-credential-choices.md)
removes Step scopes from active PAT and MCP catalogs while preserving saved IDs
and approved codes. Historical Webhook event decoding retains its owner; removing
application logic does not rewrite either persistence format.

This follows [REST retirement](2026-11-23-retire-rest-task-steps.md) and
[MCP retirement](2026-11-23-retire-mcp-task-steps.md). It supersedes the Step
portions of [data/encoding ownership](../architecture/2026-11-05-task-data-ownership.md),
[scope admission](../architecture/2026-11-20-steps-thread-scope-admission.md),
[text admission](../architecture/2026-11-07-step-text-admission.md), and
[candidate input policy](../architecture/2026-11-07-api-input-policy.md).
The original [read](../testing/2026-11-10-step-read-coordination-tests.md),
[content-write](../testing/2026-11-10-step-content-write-coordination-tests.md),
[order-write](../testing/2026-11-10-step-order-write-coordination-tests.md), and
[capacity-test](../testing/2026-11-10-step-limits-test-ownership.md) decisions
retain the rationale for their removed implementations. The
[resource requirements](../../../../docs/spec/daynight-task-steps.md) and
[design](../../../../docs/design/daynight-task-steps.md) own the current boundary.

## Alternatives

**Keep unregistered application services.** Their constructors, callable methods,
domain policy and encoding would remain maintained after all public consumers
leave. Removing the application owners makes that retirement explicit.

**Remove storage and the table with application logic.** This would combine
application assembly with DAO contracts, physical persistence proofs and
irreversible data migration. Keeping PostgreSQL signatures intact allows storage
code and data removal to retain their separate review and validation boundaries.

## Consequences

There is no production Steps application entry point. Its business-rule,
coordination and exact collection-encoding matrices leave with their owners.
Application assembly tests preserve ordinary Task, Capturer, identity and
observation wiring. Scoped construction tests also preserve catalog failure
propagation and prevent partial publication through the existing assembly test
boundary. Task, Thread and synchronization tests retain their behavior;
Ordinary Store tests retain real SQL, locks, snapshots, commit and rollback proof.

The subsequent storage retirement preserves shared Task helpers and error semantics. No data migration, production deployment or
credential-scope retirement is established by this application removal.
