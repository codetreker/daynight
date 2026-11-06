# Agent Note: Server Worker Boundaries

Status: implemented

## Problem

Account Worker reports combine current Task ownership and Project access with
independent machine observations and cloud configuration. Concrete transaction
callbacks obscure the completion outcome and make it easy to confuse reporting
with Task claim authority.

## Decision

`core/worker` owns report validation, Task observation matching, AssistantHost
freshness and configuration revision rules. `service/worker` selects the
snapshot and Worker write scopes and coordinates inventory and configuration;
`server/worker` adapts the authenticated HTTP resources. The Worker DAO binds
batch queries and configuration writes to the existing Read Committed scope.
Task claim rules remain owned by `core/task`.

The [snapshot decision](../../archived/architecture/2026-10-28-worker-runtime-snapshots.md) explains the
independent report and current-access filtering, and the [cloud configuration
decision](../../archived/architecture/2026-11-04-worker-cloud-configuration.md) records the rationale for desired and observed
configuration semantics.

## Alternatives

**Keep business rules in the store and root service.** This couples Worker
rules to the concrete transaction and duplicates ownership of claim matching,
while hiding transaction completion from the service.

**Use a Project write scope for reports.** Reports can include multiple
Projects and do not mutate them; a Project lock would change the existing
ordering and serialize unrelated work.

## Consequences

Worker reports preserve the independent transaction, batched access checks,
unchanged Task state and separate desired and observation revisions. Completion
and cleanup failures retain priority over domain refusals. The [PostgreSQL backend](2026-11-05-server-postgres-ownership.md) owns the
Worker SQL implementation.
