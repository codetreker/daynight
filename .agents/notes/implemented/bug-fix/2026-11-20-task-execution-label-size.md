# Agent Note: Task Execution Label Size

Status: implemented

## Problem

The execution mode and automatic execution labels share the ordinary Task
detail status row but use different sizes, making related secondary information
visually inconsistent.

## Decision

Both labels select `--text-xs` from the [shared Web size scale](../architecture/2026-11-20-web-font-size-scale.md).
The shared detail header applies this choice in the dialog, standalone page and
fullscreen view. The switch and status-row layout retain their existing behavior.

## Alternatives

**Keep the automatic execution label at `sm`.** The related labels would remain
visually inconsistent in the same status row.

## Consequences

The labels scale together with browser font preferences. Narrow layouts still
need to fit the complete labels and switch without overlap or horizontal overflow.
