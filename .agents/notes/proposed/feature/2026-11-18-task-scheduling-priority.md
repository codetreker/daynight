# Agent Note: Task Scheduling Priority

Status: proposed

## Problem

Chronological selection and per-Worker platform preference cannot express that
an eligible ordinary Task matters more than another Task in a different Project.
Sorting one received page cannot find a more important candidate on a later
page, and preserving metadata alone cannot make older Workers follow a new
cross-Project policy. Existing claims also carry recovery and cleanup obligations
that a new selection policy must not invalidate.

## Proposal

Introduce explicit ordinary-Task priority, ordered urgent, high, normal and low,
with normal as the creation and historical default. The
[requirements](../../../../docs/spec/task-priority.md) own product behavior;
the [design](../../../../docs/design/task-priority.md) owns storage, negotiated
projections, candidate fences, bounded multi-Project merging, publication and
validation. This note does not record an implemented feature.

Business priority would precede the existing
[platform preference](../../implemented/feature/2026-11-09-worker-platform-task-preference.md)
within new acquisition. That earlier choice reasonably reserved scarce platform
capacity when business priority did not exist. Its independent rotation rationale
is retained and extended to priority/category groups; its current implementation
remains authoritative until this proposal is delivered.

Preserve pending, active, stopped-unconfirmed and cleanup ownership. Give the
candidate stream its own snapshot fence rather than assuming MCP list protection
also covers REST discovery. Keep old response shapes unless the consumer
explicitly negotiates the new projection. Do not silently interpret unsupported
or malformed metadata as normal.

## Alternatives

**Sort the old first page locally.** This avoids a new query but misses higher
priority candidates behind old chronological pagination. It cannot satisfy the
selection requirement.

**Use a server-wide select-and-claim scheduler.** This could provide a stronger
global admission order but moves local resource admission and cross-Project
fairness into a different coordination architecture. The proposed observed
ordering explicitly does not promise global atomic start or completion order.

**Add a shared scheduling revision updated by every writer.** This makes fence
reads cheaper, but requires all eligibility mutations to update a common hot row
and expands migration and concurrency work. The initial design instead reuses
project Task count/version aggregation plus epochs in a candidate-specific
snapshot contract. Representative-load failure would require reconsidering this
choice before release, not dropping consistency.

**Decode claim JSON in SQL or filter only after pagination.** The former creates
a second protocol decoder in the DAO; the latter cannot make the advertised
pre-limit candidate selection. Two internal boolean projections, computed by the
existing core property decoders and saved atomically with every Task write,
support query filtering without either compromise. This costs a Go backfill,
additional write-path coverage and a drained old-server migration window.
It must distinguish a completed worker record from an active claim.

**Copy the draft's database enum CHECK.** Current database policy puts business
enum validation in core. A second database enum would duplicate that rule without
providing an additional concurrency invariant. The proposal keeps NOT NULL and
typed storage, validates every supported write and exposes invalid stored values
as errors instead of claiming direct SQL is an authorized business input.

**Include inheritance, predecessor promotion, preemption and aging.** These add
policy choices beyond ordering eligible Tasks. Inheritance needs separate explicit
and effective values; promotion needs graph propagation and auditability;
preemption needs a stop/ownership protocol; aging needs a durable ready timestamp.
Deferring them is affordable only while explicit priority stays separate from
eligibility, ownership and display status. No field may be reused to imply those
unimplemented guarantees. Sustained higher ranks may starve lower ranks.

**Require every old Worker to upgrade before any claim.** A server admission
gate could enforce uniform adoption but changes which already configured Workers
may acquire work. It is not approved by this proposal. Negotiated actual reports
must expose mixed or unknown adoption rather than imply universal enforcement.

## Acceptance Criteria

Deliver the linked requirements and implementable design as proposals, preserving
current documentation facts and specifying exact failure, pagination, version,
compatibility and ownership behavior. Keep prototypes outside repository delivery.
Implementation requires the design's complete owner-specific and mixed-version
matrix, including bounded scans that actually progress past local refusals.

## Risks

Task-history fence aggregation grows with history size. Continuous changes can
invalidate continuation and delay acquisition; bounded retries expose that limit
rather than claiming an empty queue. Multiple Workers have separate observations
and rotation positions. Old Workers may keep chronological/platform-first
selection, so saved priority is not evidence of universal scheduling enforcement.
Transactional index creation needs a measured maintenance window; rollback needs
a compatible binary that recognizes the appended migration identity.
