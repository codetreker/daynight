# Agent Note: Isolate Step rows from draft updates

Status: implemented

## Problem

A Steps page can contain 100 rows, each with stateful status and action menus.
Changing a local draft rebuilds every row even when its Step and controls are
unchanged. The full collection and its page boundaries must remain available,
and open menus, edit forms, focus, permissions and write receipts must retain
their existing ownership.

## Decision

The panel renders a memoized row keyed by Step ID. Each row receives the current
Step snapshot, global position, version, expansion, permissions, request pause,
pending state, renderer and action callbacks. Its editing form is passed only to
its matching row. Locale context still updates the row, while stable callbacks
track the resource and the draft facts they use. The session publishes readonly
Step snapshots, and new resources supply new Step objects.

The [Steps design](../../../../docs/design/daynight-task-steps.md#web-呈现导航与大集合)
owns the pagination, draft and focus behavior. The earlier
[position decision](../../archived/architecture/2026-11-04-task-steps-web-position.md)
records why the complete order and retained Step identity matter.

## Alternatives

**Rebuild the complete page for each draft change.** This keeps all dependencies
implicit but repeatedly renders unchanged controls and menus on a full page.

**Ignore changing callbacks or compare only Step IDs.** This would retain stale
permission, version, position or draft decisions. Default shallow comparison is
used only after those dependencies are explicit.

**Move draft ownership out of the panel.** Separate state could reduce parent
updates but would require reworking receipt, navigation and focus ownership.
The row boundary leaves that existing ownership intact.

## Consequences

Unchanged rows can retain their menu instances while draft text changes. A change
to the resource, locale, permission, request pause, callbacks or the matching
editor still updates the affected rows. A new mutable in-place Step update would
break the snapshot identity assumption and must not be introduced without
revisiting this boundary. The picker still scans its bounded page for the current
selection; its observed comparison cost did not justify changing its selection
mechanism in this decision.
