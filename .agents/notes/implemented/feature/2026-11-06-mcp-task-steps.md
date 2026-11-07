# Agent Note: MCP Task Steps

Status: implemented

## Problem

Remote clients need ordered Step reads and atomic writes with the same parent
version and collection capacity as the existing service. Default model-facing
results must remain bounded without hiding write completion facts.

## Decision

Seven MCP tools reuse the Task Steps use cases. A bounded database projection
reads summary pages and individual summaries without materializing descriptions;
page cursors bind the parent version and continuation scope. Full reads and all
writes reserve the large-object permit before calling the service. Writes return
precise versions, submitted identifiers and proven completion outcomes; summary
receipts retain the changed Step's bounded preview and position.

## Alternatives

**Read complete collections before projecting summaries.** Existing collections
can reach 64 MiB, so concurrent summary reads would consume the large-object
budget and defeat bounded control admission.

**Paginate without a parent version fence.** Concurrent changes can move Steps
between pages and silently omit or repeat items. The snapshot version check
requires clients to restart when the parent changes.

## Consequences

Full content remains available explicitly and retains existing admission limits.
A changed parent invalidates a cursor even when its Steps did not change. The
large-object slot serializes writes independently of the requested return view.
