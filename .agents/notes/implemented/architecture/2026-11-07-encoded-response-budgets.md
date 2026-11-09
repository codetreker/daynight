# Agent Note: Encoded response budgets

Status: implemented

## Problem

Row-count limits alone do not bound encoded responses or the work needed to
materialize a page. An encoding failure after a successful HTTP header can also
make an incomplete resource appear successful. At the original decision,
historical records exceeding input limits were included in the read model, so
write admission alone could not bound every read.

## Decision

Project, Team, member, invitation and attachment read paths retain protocol
response measurement before headers are committed. Their paginated readers
consume bounded candidates within a snapshot and account for their envelope,
cursor and REST newline. A candidate that does not fit remains reachable after
the last returned item; an unreturnable first item fails explicitly.

Task mutations retain transactional response admission and report post-commit
delivery failures with their completion facts. Step mutations retain their
strict complete-candidate capacity encoding. The original MCP Step read limits
included the individual JSON-RPC success response and request ID; the
[Task batch-read simplification](../simplification/2026-11-09-task-canonical-batch-reads.md)
removes those domain read budgets and stored-value validation together with Task,
property, sync, graph and search read admission.

Worker/Bot domain reads use canonical projection or ordinary decoding and
count-based pagination, as recorded in the
[Worker/Bot read simplification](../simplification/2026-11-09-worker-bot-canonical-reads.md).
The Worker list continues to project summary fields and count currently visible
tasks in SQL without transporting every complete snapshot. The shared MCP entry
retains its independent result limits.

The [Task sync design](../../../../docs/design/daynight-task-sync.md),
[Steps design](../../../../docs/design/daynight-task-steps.md),
[Worker design](../../../../docs/design/daynight-worker-snapshots.md), and
[attachment design](../../../../docs/design/daynight-task-attachments.md) own
their current mechanisms and protocols. The
[MCP Team decision](2026-11-06-mcp-team-management.md) retains its authorization
and scope rules.

## Alternatives

**Read an entire page and truncate its encoded output.** A row limit can still
materialize many large records before the byte check, and truncation can lose
the continuation position or publish an incomplete resource. This was the
comparison behind the original bounded-reader choice; the canonical-read
simplifications record the later choice of write validation and ordinary reads.

## Consequences

The remaining budgeted readers return complete accepted pages with existing
cursors. Encoding and incremental reads add work to each such page. Task, Step,
Worker and Bot domain reads no longer provide the former encoded-byte refusal or
historical stored-row validation guarantees; write checks and actual completion
facts remain. Complete directories and sync keep their unpaged contracts, with
work and memory proportional to the selected stored data.
