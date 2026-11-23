# Agent Note: MCP Task Steps

Status: implemented

## Problem

Remote clients needed ordered Step reads and atomic writes with the same parent
version and collection capacity as the existing service. Default model-facing
results had to remain bounded without hiding write completion facts.

## Decision

The original implementation exposed seven MCP tools over the Task Steps use
cases. A bounded database projection read summary pages and individual summaries
without materializing descriptions; page cursors bound the parent version and
continuation scope. Full reads and all writes reserved the large-object permit
before calling the service. Writes returned precise versions, submitted
identifiers and proven completion outcomes; summary receipts retained the changed
Step's bounded preview and position.

The [MCP Steps retirement](../simplification/2026-11-23-retire-mcp-task-steps.md)
removes those tools, their dedicated manual and protocol implementation. The
shared Steps service remains a REST dependency. This record preserves the
original pagination and memory decisions. Current MCP behavior is owned by the
retirement decision.

## Alternatives

**Read complete collections before projecting summaries.** Existing collections
could reach 64 MiB, so concurrent summary reads would consume the large-object
budget and defeat bounded control admission.

**Paginate without a parent version fence.** Concurrent changes could move Steps
between pages and silently omit or repeat items. The snapshot version check
required clients to restart when the parent changed.

## Consequences

The implementation provided explicit full reads without read-output schema or
byte admission after the [ordinary resource-page decision](../simplification/2026-11-09-canonical-resource-pages.md).
Write candidate capacity and input/concurrency rules remained. A changed parent
invalidated a cursor even when its Steps did not change, and the large-object
slot serialized writes independently of the requested return view. Those MCP
contracts are historical following retirement; REST and lower component
contracts remain with their current owners.
