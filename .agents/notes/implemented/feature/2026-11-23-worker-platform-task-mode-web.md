# Agent Note: Edit Worker platform task modes on the Web

Status: implemented

## Problem

A two-state platform preference cannot express a Worker that waits for work
requiring its own platform. The Web editor must distinguish a saved target from
a Worker's actual capabilities and application while supporting independently
upgraded services and Workers.

## Decision

The Worker configuration editor presents the negotiated platform task modes in
one native select, with platform-specific labels and a description of the current
choice. A legacy service retains the two-state view. The service capability
response selects the wire projection, while a real item in the latest accepted
Worker report establishes support for newly enabling `only`. Saving a target
does not establish application. The editor retains drafts through capability
changes and conflicts, and allows an existing strict target to be retained or
explicitly exited without a current support item. The
[Web requirements](../../../../docs/spec/daynight-web.md#云端运行配置)
and [configuration protocol](../../../../docs/spec/daynight-worker-configuration.md#平台任务规则能力)
own the observable behavior and wire contract.

This extends the Web editor from the two-state
[platform preference decision](2026-11-09-worker-platform-task-preference.md),
using the independent projection and observation rules of the
[platform mode protocol](2026-11-23-worker-platform-task-mode-protocol.md).

## Alternatives

**Infer strict support from the saved target or legacy boolean.** Neither proves
that the current Worker understands or applies the stricter rule; an older
report can replace the supporting observation. A real enum item and its applied
value provide separate evidence.

**Keep a checkbox for preference and add a separate strict toggle.** Two controls
would allow conflicting combinations for a single mutually exclusive setting.
A native select represents the three choices directly and preserves keyboard
interaction.

## Consequences

Users can see and edit all supported modes without losing unrelated drafts when
capabilities change. Older services remain usable with two choices; an older
Worker cannot be represented as having applied the strict target. Strict
selection remains a client policy rather than server claim admission, so a
Worker downgrade does not guarantee continued strict selection.
