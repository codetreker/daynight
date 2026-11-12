# Agent Note: Settle worktree cleanup from fresh resource observations

Status: implemented

## Problem

A deletion can report an error after its intended filesystem and Git effects have
completed. Treating every such error as retained resources prevents retirement,
while treating an error or an expired observation as proof of absence can release
responsibility before the original mutation has closed.

## Decision

The Git manager joins the admitted mutation and checks the original directory and
registration with a fresh observation budget. The effect and observation each use
the existing five-minute limit and inherit the outer cancellation signal. An
absent result carries every effect error to callers for diagnostics before they
settle backend, local, schedule and manifest responsibility. If resources remain,
the original error propagates; if observation also fails, both errors remain in
the cause chain. Outer cancellation prevents new observation and does not abandon
in-flight local closure. Callers do not repeat the equivalent Git postcondition.
The [manifest adoption decision](2026-11-12-worktree-manifest-adoption.md) owns
resource identity and retirement order.

## Alternatives

**Retain the original effect deadline for observation.** A deadline exhausted by
an effect would prevent the fresh check needed to distinguish completed deletion
from retained resources.

**Ignore deletion errors when the path appears absent.** A path alone does not
establish Git registration absence or local closure, and hides the original error.

## Consequences

A later normal reconciliation can retire resources after an error without a
restart, while unreadable or still-present resources retain their responsibility.
The observation only describes the current state: descendants detached from Git
stdio can still write after local closure and handover. An unreturned filesystem
call continues to hold its mutation gate despite cancellation or a deadline.
