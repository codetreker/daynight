# Agent Note: Encoded response budgets

Status: implemented

## Problem

Row-count limits alone do not bound encoded responses or the work needed to
materialize a page. An encoding failure after a successful HTTP header can also
make an incomplete resource appear successful. Historical records can exceed
today's input limits, so admission alone cannot bound every read.

## Decision

Read responses are measured using their actual protocol projections before
headers are committed. Existing paginated readers consume bounded candidates
within a snapshot and account for the envelope, cursor and REST newline. A
candidate that does not fit remains reachable after the last returned item;
an unreturnable first item fails explicitly. Task mutations retain their
transactional response admission and report post-commit delivery failures with
their completion facts. The Worker list projects summary fields and counts
visible tasks in SQL instead of decoding every complete snapshot.

The [Task sync design](../../../../docs/design/daynight-task-sync.md),
[Steps design](../../../../docs/design/daynight-task-steps.md),
[Worker design](../../../../docs/design/daynight-worker-snapshots.md), and
[attachment design](../../../../docs/design/daynight-task-attachments.md) own
their respective limits and protocols. The existing
[MCP Team decision](2026-11-06-mcp-team-management.md) retains its authorization
and scope rules.

## Alternatives

**Read an entire page and truncate its encoded output.** A row limit can still
materialize many large records before the byte check, and truncation can lose
the continuation position or publish an incomplete resource.

## Consequences

Callers receive complete pages and can continue using the existing cursors.
Encoding and incremental reads add work to each page. The 64 MiB sync output
limit is not a fixed memory bound for the complete assignee list, and complete
directories retain their existing unpaged contracts.
