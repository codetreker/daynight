# Agent Note: Webhook Subscription Authorization Continuity

Status: implemented

## Problem

A webhook subscription must retain its identity across configuration edits while preventing a later grant from reviving work authorized before an actual access gap. Independent Team membership and direct grants can overlap, so removing one source alone does not establish a loss of access.

## Decision

Subscriptions and event bindings have independent stable identities. A source transaction locks affected subscriptions and evaluates the current union of authorization sources after the wait; a real loss advances the subscription epoch and requires explicit confirmation after access returns. Configuration transactions fence Project and Team roots before endpoint and subscription locks, and compare the caller version both with the planning observation and the locked endpoint. Effects and operation receipts commit together. The [management design](../../../../docs/design/webhook-management.md) describes the module and its transaction boundaries.

## Alternatives

**Recompute eligibility only at send time.** A lost and later restored grant would appear continuously eligible and could revive work authorized before the gap.

**Invalidate on every source removal.** A concurrent handoff between a Team membership and a direct grant can preserve access throughout; invalidating that subscription would interrupt a valid authorization.

## Consequences

Source mutations share the cost and failure semantics of refreshing affected subscriptions. An actual access gap requires an explicit confirmation, while retained bindings keep their identities through continuous access. Event capture and delivery independently preserve and check the original proof.
