# Agent Note: Unsupported usage in task row status

Status: implemented

## Problem

A service that cannot provide usage adds a separate summary line to every ordinary task row. This repeated message consumes vertical space even though it does not describe a task failure or a measured usage value.

## Decision

Ordinary task rows show a compact neutral service-unsupported label immediately before the lifecycle status, using the same usage subscription as their summary. The [usage specification](../../../docs/spec/task-token-usage.md#task-用量界面) defines its placement and distinguishes it from provider-level unsupported data. Detail and other usage consumers retain their own presentation.

## Alternatives

**Keep the separate summary line.** It preserves the longer explanation but increases every affected row's height for a service-wide limitation.

## Consequences

The row saves space without adding a control or implying a zero measurement. The shorter label gives less explanation than Detail; other errors and recorded summaries retain their existing content and retry behavior.
