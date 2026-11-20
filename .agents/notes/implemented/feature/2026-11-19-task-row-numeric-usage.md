# Agent Note: Numeric usage in ordinary task rows

Status: implemented

## Problem

Ordinary task lists repeat usage loading, missing-data and failure messages even
when there is no Token number to compare. Moving service-unsupported text beside
the lifecycle status reduced row height, but still devoted space and attention
to a service capability rather than a task measurement.

## Decision

Ordinary task rows show usage only when the shared compact metric selector finds
a known total, output or input Token value, in that order. A known zero qualifies.
The row keeps the existing exact formatting, completeness state and link to the
usage tab. A retained numeric summary remains visible after a refresh failure;
query diagnostics and retry controls belong to Detail and its usage tab.

This replaces the ordinary-row presentation from the
[service-unsupported label decision](2026-11-19-task-row-unsupported-usage.md).
The [usage specification](../../../../docs/spec/task-token-usage.md#task-用量界面)
owns the visible rules. The existing usage subscription, batching, cache,
authorization and inactive lifetime remain shared with other consumers. Detail,
graph nodes and Chain/Goal aggregates retain their own presentation.

## Alternatives

**Keep a service-unsupported label beside status.** It avoids a separate summary
line, but repeated labels still add no comparable measurement and consume space
in every affected row. The same issue remains for loading and unknown summaries.

**Hide the entire summary whenever a read fails.** This would discard useful
retained numbers during a temporary failure. The row instead follows the reading
layer's retention and authorization decisions and exposes its retained value.

## Consequences

Rows without compact Token measurements have no usage-specific element or gap.
Cache and reasoning measurements alone do not introduce a row summary because
the compact reading does not present them. Users inspect Detail for missing-data
explanations and query failures; the row no longer offers a separate retry.
The shared selector keeps visibility and metric formatting aligned without
changing the diagnostics required by other usage consumers.
