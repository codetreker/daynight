# Agent Note: Chain representative detail label

Status: implemented

## Problem

A complete ordinary Task chain exposes its representative through a detail
button labelled as a Goal. The button opens an ordinary Task, so the label
misidentifies the resource and its destination.

## Decision

The representative entry names Task details in both supported languages and
includes the representative title in its accessible name. It retains the
existing Task navigation, completion time hint and focus restoration.
Actual Goal entries keep their Goal-specific labels.

## Alternatives

**Keep the Goal label.** This would continue to describe an ordinary Task as a
Goal and make the entry misleading.

## Consequences

The label identifies the resource actually opened without changing chain scope
or navigation. The representative remains a separate entry from ordinary member
rows, as described in the [shared row decision](../architecture/2026-11-15-shared-project-task-row.md).
