# Agent Note: Current Worker Claim Inventory

Status: implemented

## Problem

A worker needs the current set of claims it owns to reconcile local execution
resources. A claim can succeed remotely before its first local record is
committed, and ownership can later end or move. Looking up only task IDs already
stored locally cannot discover the first case. Candidate eligibility is also
insufficient: an explicitly resumed claim can remain active while automatic
permission or platform requirements would exclude a new candidate.

## Decision

The existing project task list accepts an optional canonical UUID `workerId`.
The service pairs it with the authenticated principal's user ID and selects only
matching active worker records. Explicit ordinary filters still combine by AND;
workerId alone adds no task status, readiness, permission or platform condition.
The cursor binds both workerId and the implicit user ID whenever this filter is
present. An ordinary unfiltered cursor retains its existing user-neutral scope.

Storage scans ordered candidates through the existing task properties decoder
and collects matching records before the final page limit and lookahead. Ordinary
queries retain their SQL limit. This preserves the opaque TEXT storage contract
without converting an entire properties value through PostgreSQL JSON types or
adding a worker projection, index or claim table.

The typed client carries workerId across pages and rejects responses with null,
inactive or different-worker claims. `listTasks` succeeds only after all pages;
errors, duplicate identities and repeated cursors do not produce a partial
success. `listTaskPage` remains an explicitly partial operation. No public task
CLI option or new worker runtime is introduced by this contract.

A caller must collect workerId-only pages for every relevant project successfully
before using absence as an ownership fact. It cannot use extra candidate filters
or a failed/partial traversal to authorize cleanup. Automatic reconciliation uses
claim membership, not task-status classification. Known-task reads remain useful
for explicit version-bound writes and uncertain mutation results.

This partially supersedes the no-inventory discovery choice in the
[worker design](2026-10-22-worker-design.md) and
[claim foundation](2026-10-24-worker-claim-foundation.md). Their original rationale
remains valid for explaining why current ownership cannot reconstruct lost
worktrees, frozen configuration or native history. The
[server architecture](../../../../docs/design/daynight-server.md#列表与读取一致性)
owns the query and pagination mechanism; the
[claim architecture](../../../../docs/design/daynight-worker-claims.md#进程内客户端候选和恢复)
owns its typed-client use.

## Alternatives

**Keep only known-task reads.** They reconcile a known mutation or existing local
execution, but cannot discover a successful claim whose local insert never
committed. A current ownership query closes that discovery gap while leaving
resource recovery explicit.

**Convert stored properties in SQL.** The field intentionally retains opaque PR
JSON text and existing special-character semantics. Reusing its decoder avoids
introducing a separate database JSON interpretation solely to select ownership.

**Add worker projection columns or a claim table.** They could make a selective
inventory query cheaper, but introduce another stored representation and
migration/write synchronization for a query already expressible with current
records. Reconsider a projection when measured inventory load justifies it.

## Consequences

The inventory has an explicit identity scope and cannot be confused with ready
work. It reuses current authorization, task records, pagination and error
propagation. A worker-filtered page may scan many nonmatching project rows; PostgreSQL and
pgx result draining can still process the remaining candidates. Collection
buffers only the matching lookahead rather than an unbounded task array. Missing local resources remain recovery failures,
and this service/client capability does not establish foreground runtime or
cross-platform native-agent delivery.
