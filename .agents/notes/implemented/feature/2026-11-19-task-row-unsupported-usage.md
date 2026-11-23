# Agent Note: Unsupported usage in task row status

Status: implemented

## Problem

A service that cannot provide usage adds a separate summary line to every
ordinary task row. This repeated message consumes vertical space even though it
does not describe a task failure or a measured usage value.

## Decision

The original decision placed a compact neutral service-unsupported label
immediately before the lifecycle status, using the same usage subscription as
the summary. This saved the separate summary line while distinguishing a service
limitation from a zero measurement or provider-level unsupported data.

The [numeric usage decision](2026-11-19-task-row-numeric-usage.md) supersedes this
ordinary-row presentation: rows now show a summary only when a compact Token
measurement is known. Detail and other usage consumers retain their own
presentation. The [usage specification](../../../../docs/spec/task-token-usage.md#task-用量界面)
owns the current visible rules.

## Alternatives

**Keep the separate summary line.** It preserved the longer explanation but
increased every affected row's height for a service-wide limitation.

## Consequences

The original shorter label reduced row height without adding a control or
implying a zero measurement. It gave less explanation than Detail and retained
other error and recorded-summary content. Repetition beside lifecycle status
still consumed attention without a numeric measurement, motivating the
superseding decision.
