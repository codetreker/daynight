# Agent Note: Deleting current Task Step records

Status: implemented

## Problem

A Task's current ordered work can contain a record that must be removed without
removing the parent or its external materials. Deletion must preserve surviving
identities, content and timestamps while closing the positional gap and advancing
the shared parent version once. A repeated request or lost response must not be
mistaken for a successful deletion or proof of its historical cause. The last
record's removal must still produce a complete, readable empty collection.

## Decision

The [resource contract](../../../../docs/spec/daynight-task-steps.md) exposes a
JSON DELETE containing only the observed parent version. It resolves the exact
task-local target after project/member/parent/version admission. A missing target
is a child absence, not a no-op; an old version conflicts first. Existing targets
can be removed in every Step and Task state, subject to normal membership and
parent tombstone checks. A current missing target is checked before version
exhaustion, while removing an existing target always requires a new version.

A pure `DeleteCandidate` copies the remaining rows into dense order without
altering any survivor's identity, content, status or timestamps. Its empty result
is an explicit nonnil collection. The use case reuses the neutral admission,
public codec and transaction completion owners from the
[atomic-add decision](2026-11-04-task-steps-atomic-add.md). Before any mutation,
it checks version exhaustion, samples database UTC microsecond time for the
parent alone and encodes the complete remaining candidate with its new version.

Persistence deletes the one current row, compacts only positions after it and
touches the narrow parent version/time once. Both SQL affected counts are checked
against the admitted collection. All survivor content timestamps,
parent business and execution data, attachments, PRs and Session/Worker ownership
remain unchanged. The existing deferred position constraint validates the final
dense order; no new migration, tombstone or history storage is introduced.
The handler returns HTTP 200 and the frozen complete remaining resource, including
`steps: []` for the terminal deletion, through the existing response owner.

The deleted Task-local ID is released. A later explicit POST using that ID
creates a new record with newly sampled creation/update times and the submitted
content or normal Add defaults; it does not restore the former record. Deleted
records have no public history or recovery resource. Unknown completion retains
the original Project/Task/Step identity for read-only current-fact reconciliation.
Current absence cannot establish that an unknown delete caused it, and current
same-ID presence cannot establish that the former record survived. The handler
records `delete` with existing transaction/response facts, without automatic
retry or replay.

## Alternatives

**Keep a Step tombstone or a reserved deleted ID.** The current resource has no
history or recovery contract, and callers may explicitly add a new record under
a released ID. A tombstone or permanent reservation would add retention and
identity semantics unrelated to the required current-record operation.

**Treat a missing target as a successful no-op.** Absence can follow another
writer or a lost response and does not prove which operation removed the record.
A current-version child 404 exposes the actual current fact while preserving
ordinary shared-version conflict ordering.

**Return 204 or remove the row before response validation.** Callers need the
complete remaining order and parent version, including a real empty array.
Encoding the copied candidate before target deletion and tail compaction keeps
response capacity refusal separate from avoidable data writes.

## Consequences

Deletion and dense tail compaction commit as one state with the parent version.
Same-version Task and Steps writers permit at most one actual change. Confirmed
rollback after target deletion, compaction or parent touch restores the complete
prior state; ambiguous Commit and response loss keep their independent completion
classification. Deleting a Step does not cancel external work or remove its
referenced materials.

Candidate construction and complete encoding remain linear in the collection;
persistence is linear in the trailing positions. Real PostgreSQL/HTTP tests
verify every state, terminal empty output, released-ID new records, preserved
survivors/materials, exact-version competition and confirmed rollback. Maximum
resource HTTP checks run separately under the stress tag. Current Steps remain a
working collection, not an audit history, and no bulk, recovery or replay
mechanism is introduced.
