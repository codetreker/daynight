# Agent Note: Explicit Timeline History Save Policies

Status: implemented

## Problem

Task body history must exclude independent tool output without changing message
text or charging excluded output against the retained history budget. When the
save policy was introduced, the SQL timeline also owned live reconstruction,
revision allocation, pending approval discovery and tool image positions.
Filtering that shared source automatically would have lost online state before
its consumers could distinguish body history.

## Decision

The timeline save operation accepts explicit `task_body`, `bot_detail` and
compatibility `legacy` policies and returns a policy-tagged `saved`, `unchanged`
or `excluded` result. Task body selection uses entry kind. Excluded entries retain
structural and identity validation but do not serialize, hash or consume retained
body capacity. Exclusion cannot replace an existing retained identity.

The lifecycle history entry accepts stable, caller-assigned identity and owns its
original journal transaction. It does not publish online events or acknowledge
pending operations. Initial production projection used `legacy` because its live
consumers still required the shared detailed history. The subsequent
[Controller activation decision](2026-11-19-controller-task-body-history.md)
separates online ownership and enables body history for newly created Task
executions. Existing executions retain their stored policy. The current contract
belongs to the [SQLite content design](../../../../docs/design/session-sqlite-content.md).

The [storage contract decision](2026-11-18-session-storage-contracts.md) remains
the requirement owner. Policy support in this module does not advertise the
versioned product capability. Bot identity cannot be inferred from
`testExecutionId`, which is also used for ordinary Test Sessions.

## Alternatives

**Enable Task filtering directly in existing projection.** This would immediately
reduce retained output, but filtered tools would lose their previous revision and
sequence, outbox overflow could no longer rebuild them, and pending approvals and
tool image positions would disappear. Those are guarantees that must be preserved
before activation.

**Implement live storage, relay and archive redesign with the save policy.** This
would couple the module interface to a new online lifetime before the owners of
reconnection, resource release and archive compatibility have established their
behavior. An explicit stable-entry input leaves those owners free to manage online
identity without deriving it from retained history.

## Consequences

Real SQLite tests can prove selective persistence, exact current totals, message
preservation, revisions, rollback and operation independence. They do not prove
production body-only synchronization, reconnect behavior or bounded transport
storage. Those guarantees belong to the Controller activation and protocol
owners; this save interface alone never established them.

The activation prerequisites were separate live state, preserved approvals and
tool resources, source acknowledgements and versioned synchronization/archive
consumers. The linked activation decision owns their implementation. A caller
must not mix a legacy source with a body-only capability declaration. This API
does not purge existing rows or store identity metadata for excluded entries;
their revisions and ordering remain the online owner's responsibility. Save
results become durable only when the caller's outer transaction commits.
