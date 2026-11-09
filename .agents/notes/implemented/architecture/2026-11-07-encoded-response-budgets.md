# Agent Note: Encoded response budgets

Status: implemented

## Problem

Row-count limits alone do not bound encoded responses or the work needed to
materialize a page. An encoding failure after a successful HTTP header can also
make an incomplete resource appear successful. At the original decision,
historical records exceeding input limits were included in the read model, so
write admission alone could not bound every read.

## Decision

Task, Step, Project, Team, member, invitation and attachment read paths retain
protocol response measurement before headers are committed. Their paginated
readers consume bounded candidates within a snapshot and account for their
envelope, cursor and REST newline. MCP Step limits include the individual
JSON-RPC success response and its request ID. A candidate that does not fit
remains reachable after the last returned item; an unreturnable first item fails
explicitly. Task mutations retain transactional response admission and report
post-commit delivery failures with their completion facts.

Worker/Bot domain reads instead use canonical projection or ordinary decoding
and count-based pagination, as recorded in the
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
comparison behind the original bounded-reader choice; the Worker/Bot
simplification records the later canonical-read alternative.

## Consequences

The remaining budgeted readers return complete accepted pages with existing
cursors. Encoding and incremental reads add work to each such page. The 64 MiB
sync output limit is not a fixed memory bound for the complete assignee list,
and complete directories retain their existing unpaged contracts. Worker/Bot
domain pages no longer provide the former encoded-byte refusal or historical
stored-row validation guarantees; their write checks remain.
