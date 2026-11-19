# Agent Note: Task detail usage placement

Status: implemented

## Problem

Task details repeat usage above the reading tabs and inside the usage tab. The
header copy adds height, including loading, error and service-unsupported messages,
to the controls needed for reading and operating a task.

## Decision

Ordinary task dialogs and standalone pages display usage inside the usage tab.
Their shared detail header has no usage summary or reserved space. The tab and
its direct URL remain the detail entry points, as defined by the
[usage specification](../../../../docs/spec/task-token-usage.md#task-用量界面).
The [usage architecture](../architecture/2026-11-18-single-table-token-usage.md)
continues to own independent usage queries and their lifetime.

## Alternatives

**Keep both summaries.** A header summary offers immediate visibility, but repeats
the tab's information and makes service-wide limitations occupy task-control space.

## Consequences

The header stays compact across usage states. Reading usage requires selecting
its tab or following a direct link. Task rows and aggregate consumers retain their
own entry points; shared usage components and request behavior remain unchanged.
