# Agent Note: Goal Session summary

Status: implemented

## Problem

A collapsed Goal shows its own lifecycle, child progress and active Worker
claims, but does not show whether an accessible child's current Session needs
attention or is working. Opening every child to discover that state makes the
Goal less useful as an overview. Claim ownership and execution permission do not
describe the current Session activity.

## Decision

The Goal heading aggregates the existing page-local Session summaries over its
complete direct ordinary children, once per Task, independently of disclosure
and child Tag filtering. It uses the chain precedence and shared annotation;
its status control expands the Goal rather than selecting a child's Session.
The visible Goal container owns the observation registration, including while
collapsed, and the shared store retains its identity, permission and freshness
admission. The Goal's lifecycle presentation and active-claim indicator remain
independent. The [Session status design](../../../../docs/design/task-session-status.md)
owns observation and display details; the [flat Goal list decision](../simplification/2026-11-13-goal-flat-list.md)
owns direct member presentation.

## Alternatives

**Observe only expanded children.** This hides the summary in the collapsed
state, where readers need it to decide which Goal to inspect; filtering could
also remove a contributing child.

**Infer Session activity from claims or permission.** An active claim describes
ownership, and permission permits future claiming. Neither establishes whether
the current Session is working, waiting or needs inspection.

## Consequences

The Goal heading remains useful while collapsed without new per-Task requests,
polling or persisted Session data. Observations remain bounded by the existing
store's freshness and access rules, so an absent annotation is not proof that
every child is idle. Visibility and membership updates must keep the Goal's
registration in sync, and the interactive summary must remain separate from the
heading disclosure to preserve native controls.
