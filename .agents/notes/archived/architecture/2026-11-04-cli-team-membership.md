# Agent Note: CLI Team Membership Management

Status: implemented

## Problem

Members need a scoped directory and a way to leave, while administrators need to
change existing roles and remove members. A decision made on an earlier
membership must not silently apply to a changed or recreated relationship. A
successful self-exit also removes access to the Team, so a subsequent protected
read cannot establish whether the write succeeded.

## Decision

The CLI reads the selected Team's complete member directory and uses the real
membership version for role changes, removals and self-exit. An explicit
`--if-version` retains the exact earlier observation and is checked against the
current target before confirmation. Writes reuse Team confirmation, bind the
current identity, validate the response principal and receipt, and never replay
an unknown result. The actor role in a confirmed receipt describes remaining
access; self-exit consumes that receipt without a subsequent Team read.

The [Team membership decision](2026-11-04-team-membership-management.md) owns
server authority, serialization and independent Project grants. The [Team
lifecycle confirmation decision](2026-11-04-cli-team-lifecycle.md) owns the
shared confirmation and unknown-result rationale. The [client requirements](../../../../docs/spec/daynight-project-task.md#team-成员管理)
are the command contract.

## Alternatives

**Use a Project grant or Team metadata version.** Neither version identifies the
member relationship being changed, so it cannot protect an earlier decision
against a changed or recreated membership.

**Read the Team after self-exit.** The actor has lost membership and the read can
fail even after a successful commit; the validated mutation receipt is the
reliable result.

## Consequences

Members can inspect only their Team's directory, and admins manage existing
relationships without changing Project grants or the configured default. A
conflict or unknown result needs a fresh observation and explicit decision;
current state cannot reconstruct a lost receipt. Personal membership remains
immutable and ordinary Teams retain at least one administrator.
