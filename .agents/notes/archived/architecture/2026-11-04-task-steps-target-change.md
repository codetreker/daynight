# Agent Note: Existing Task Step changes and semantic no-op

Status: implemented

## Problem

A Task record's title, Markdown and status must be editable without replacing its
identity or order. Content pairs must save atomically, omitted values must remain
unchanged, and repeating current values must not invent a new revision or time.
The parent Task is also written by other operations, so a same-value request
still needs current-version admission. Technical response capacity and maximum
version limits must not prevent a valid unchanged result.

## Decision

The [resource contract](../../../../docs/spec/daynight-task-steps.md) exposes
content PATCH for title and/or description and a separate status PUT. Both
resolve the exact task-local eight-hex target through one existing-target change
path. PATCH preserves omitted fields and accepts an empty description as an
explicit clear. Status has four freely selectable values; neither the Step's
prior state nor the parent Task state creates a transition gate.

The path reuses the project/member/parent/version admission, codec, narrow parent
touch and completion classification established by the
[atomic-add decision](2026-11-04-task-steps-atomic-add.md). After the parent version
is admitted, the complete current collection is validated and the target is
resolved. A pure candidate copies the target, applies supplied fields and
compares semantic values without changing identity, position or timestamps.
The two public operations build only their own allowed fields; the internal
shared change value does not expand public PATCH or create future operation
dispatch.

An unchanged candidate encodes the old complete resource and commits only its
read/locking transaction. It does not sample the database clock, update a Step
or touch the parent. This preserves all versions and times, including at the
maximum positive int64 parent version. Stale same-value requests conflict before
comparison; a missing target fails before exhaustion. Business `unchanged` and
transaction `committed` are independent facts.

For an actual change, exhaustion is checked before sampling database UTC
microsecond time. Only target updatedAt and parent updated_at receive that time,
and the candidate parent version advances once. Complete encoding and exact
64 MiB admission precede every data write; the frozen codec bytes are returned
after confirmed Commit. Persistence updates the one target's merged content,
status and updated_at, then touches the parent once. It leaves target created_at
and position, other rows, Task policy, dependencies, properties, timing and
Worker/Session data unchanged. The full Task updater is not called.

The handler retains the existing safe diagnostics and transaction/response
facts, identifies operations as `update` or `set_status`, and records business
`changed` or `unchanged`. No-op emits no persist phase. Unknown completion or
response loss retains the original target identity for read-only reconciliation;
current state does not establish historical attribution.

## Alternatives

**Give PATCH and status separate write pipelines.** Both require identical
admission, target lookup, comparison, time, capacity and persistence ordering.
Duplicating that mechanism allows same-value and failure semantics to diverge.
One actual target-change path serves the two delivered operations without a
registry or speculative mutation interface.

**Compare values before the parent version.** A stale request could then succeed
because its requested value happens to match a later state. Parent-first
admission preserves the same concurrency unit as Task metadata and additions.

**Always update time and version.** This converts a repeated value into a real
mutation and rejects otherwise valid requests at MaxInt64. Comparing semantic
values before exhaustion, clock and writes preserves unchanged state exactly.

**Apply a partial update before checking complete capacity.** A short title or
status can increase encoded bytes even when no large Markdown was supplied.
The common public codec must check the complete merged candidate first; target
SQL cannot substitute for resource admission.

## Consequences

Paired title/description changes are atomic, status changes preserve content,
and no-op leaves every stored value untouched. Same-version actual writes permit
at most one change. A no-op that finishes before a real change can also return
success without advancing the version; a real change that finishes first makes
the old no-op version stale. Tests must distinguish actual change count from
successful response count.

Every response still validates and encodes the complete collection, so no-op and
small target updates remain linear in collection size and encoded bytes. Status
length growth may be refused near capacity, while shrinking a legal description
can free capacity. Real PostgreSQL/HTTP tests verify no-op query absence,
concurrency, target and parent-touch rollback, and preserved ownership. Opt-in
stress tests separately verify exact capacity, one-byte refusal, shrinking and
status growth through actual response bytes and database time.

Public writes also include [position moves](2026-11-04-task-steps-position-move.md),
which preserve all Step content timestamps and use their own order candidate and
interval persistence. They reuse neutral admission, completion and response
facts without routing through content timestamp assignment. The shared
mechanisms serve actual operations and retain explicit method refusals for
unsupported requests. No new retry, operation ledger, lifecycle gate or replay behavior is required.
