# Agent Note: Goal Prerequisite Batch Reader

Status: implemented

## Problem

Task summary consumers need the direct acceptance prerequisites of selected
Goals without mixing them into ordinary Task execution dependencies. Reading
each Goal separately adds database round trips and can combine relationships
with summaries from different snapshots. A delta batch can contain a downstream
Goal whose prerequisites have not changed within the time window.

## Decision

`TaskReader.TaskSyncGoalDependsOn` reads same-Project live Goal prerequisite IDs
for a selected set of Goal IDs through the existing callback-scoped snapshot.
It filters both endpoint types and effective deletion, reads only typed Goal
edges, and returns sorted IDs with explicit empty slices for live selected
Goals without edges. The query uses the existing downstream dependency key.
The [Goal relationship design](../../../../docs/design/goal-dependencies.md#项目内前置批量读取)
owns the full storage contract.

The initial storage delivery left public TaskSync output unchanged so the Server
and embedded Web consumer could switch together without conflicting with old
cached Goal summaries. The [Goal summary decision](2026-11-23-goal-summary-admission.md)
now combines this batch reader with public snapshot and delta summaries and a
paired browser cache rebuild. Ordinary dependency states and graph traversal
continue to use typed Task edges.

## Alternatives

**Read each Goal through the relationship API.** That projection also carries
cross-Project authorization and pagination. Repeating it for a summary batch
adds requests and does not share the summary transaction's snapshot.

**Filter prerequisites by the summary delta window.** An unchanged prerequisite
would disappear from a changed Goal's complete adjacency list. The window
selects source summaries; selected source IDs bound the relationship query.

## Consequences

The batch has one database query and shares the summary's Repeatable Read
transaction without adding locks, indexes, revisions or sync parameters.
Cross-Project relationships remain with their existing authorized reader.
Callers must authorize the Project and pass the Goal IDs actually selected for
their summary batch. PostgreSQL tests own endpoint filtering, explicit empty
results, delta selection and same-snapshot behavior.
