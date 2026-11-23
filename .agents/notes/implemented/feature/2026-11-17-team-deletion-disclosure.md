# Agent Note: Team Deletion Disclosure

Status: implemented

## Problem

The Team settings deletion panel occupies space with an explanation and a
rarely used destructive action. Reducing that space must preserve the existing
confirmation, permission checks, operation results and settings continuity.

## Decision

The General section presents deletion in a closed native disclosure. Its
summary is the full-width keyboard and pointer target; the explanation and
existing delete button appear when opened. The Team settings instance owns its
open state, retaining it across section and locale changes and background
checks. A newly mounted instance starts closed. Errors and unknown-result
reconciliation remain outside the disclosure. The existing confirmation and
focus restoration continue to own deletion.

The [settings sections decision](2026-11-10-team-settings-sections.md) owns the
identity and Team lifetime of the containing instance.

## Alternatives

**Keep the expanded panel.** It exposes the low-frequency action and its
explanation at all times, consuming space in the primary settings view.

**Add a separate danger-zone navigation level.** A second label for one action
adds a step without adding a meaningful grouping.

## Consequences

The default view is compact while the native control supplies keyboard and
expanded-state semantics. The local state must survive temporary removal of the
card during access checks without changing permission or operation guards.
