# Agent Note: Task Parent Read Projection

Status: implemented

## Problem

Existing clients interpret `parentId` as a Goal navigation target. Returning an
ordinary parent through that field sends them to the wrong resource view. New
clients also need direct-child selection and accurate search context. Worker
admission must follow the containing Goal through ordinary parents without
changing dependency readiness or taking Task locks after Worker locks.

## Decision

The read model retains the actual direct parent ID and type. Default protocol
projections expose only a direct Goal through `parentId`; an explicit HTTP header
or MCP parameter adds nullable `parentTaskId` and paired ordinary-parent search
context. Direct ordinary-parent filters are separate from Goal filters and bound
to cursors. My Tasks retains its field set and obtains Goal ID and title from the
same direct Goal join. The [parent read design](../../../../docs/design/daynight-task-parent-reads.md)
owns the representations, filtering and transaction details.

Candidate selection and transactional claiming share a same-project recursive
terminal-Goal predicate. Starting a Task prelocks it and any direct todo Goal in
UUID order before Worker configuration and execution checks. Ordinary parents
and more distant Goals do not auto-start. This refines the
[typed resource reads](2026-11-11-typed-task-resource-reads.md) and
[Goal start decision](../feature/2026-11-13-start-goal-with-child.md).

## Alternatives

**Return ordinary parents through `parentId`.** Existing Goal navigation and
exact default response contracts would change for supported clients.

**Resolve parent types in each serializer.** Per-row reads add queries and can
disagree with the original snapshot; the resource view already supplies type.

**Check only the direct parent during claiming.** Deep descendants could escape
a terminal Goal's restriction, while rejecting every ordinary parent would
prevent valid deep claims.

## Consequences

New relation views are opt-in and their encoded bytes participate in write
admission. Recursive queries add candidate and claim work proportional to the
shallow parent chains; no closure table or new index is required. Existing claim
inventory, dependency readiness, Goal direct progress and minimal receipts keep
their meanings. Public ordinary-parent creation remains separate protocol work;
the [parent lifecycle decision](2026-11-23-task-parent-lifecycle.md) governs
internal writes and lifecycle admission.
