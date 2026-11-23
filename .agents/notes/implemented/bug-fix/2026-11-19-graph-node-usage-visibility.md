# Agent Note: Graph node usage visibility

Status: implemented

## Problem

Graph nodes have limited space for task information. Loading and unavailable
usage states occupied a line even when they provided no numeric reading.

## Decision

Graph hosts that provide node usage render the entry only when total, output or
input has a known value, using the existing compact reading and its priority order. Zero
is a known value. A retained summary remains visible during a transient refresh
failure. The node dimensions and graph layout do not depend on usage state. The
[chain usage dialog](../feature/2026-11-20-chain-usage-dialog.md) removes usage
from project-list chain graph hosts while retaining it in Goal graph contexts.

## Alternatives

**Show diagnostics in each node.** This consumes space without providing a
reading; the task list and detail retain their diagnostic surfaces.

## Consequences

Nodes without a displayable reading have no usage element or dedicated spacing.
The graph does not distinguish loading, missing data and errors at the node;
the existing detail and list views remain available for diagnosis.
