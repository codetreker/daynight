# Agent Note: Worker Reviewer

Status: implemented

## Problem

A standalone reviewer requires its own foreground command and discovers PRs by a local repository boundary. Worker-assigned existing PRs need a continuous execution path that respects server eligibility without losing publication recovery or interfering with development tasks.

## Decision

The Worker hosts the existing review coordinator with a complete paginated assignment source and separate local state. GitHub remains authoritative for review eligibility and publication, while the service owns assignment and participation. Three independent Reviewer prompt resources are captured before reservation and checked again at launch. Pending publication retains the original attempt until process exclusion and GitHub readback settle it. The [design](../../../../docs/design/worker-reviewer.md) describes the runtime boundaries.

## Alternatives

**Enumerate projects and query assignment per PR.** This reads unrelated PRs and multiplies requests, so the server supplies a filtered paginated list instead.

**Reuse standalone reviewer state.** Its historical cutoff and local worktree ownership do not establish Worker assignment, and migration would couple the two lifecycles. Independent state permits a controlled switch at the cost of possible repeat review.

## Consequences

Review participation and task scheduling remain independent, and a failed list read does not imply a closed PR. The separate state does not deduplicate reviews across the switch. GitHub and Copilot availability still determine execution, and an unknown publication or unconfirmed process retains its recovery responsibility.
