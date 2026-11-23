# Agent Note: Retire Herdr Platform Validation

Status: implemented

## Problem

The Worker no longer admits Herdr executions, yet CI still installs Herdr and
runs a dedicated three-platform execution and cleanup suite. That suite depends
on retired execution paths and would obstruct removal of their remaining source.
Its results cannot establish the state of existing user-owned resources.

## Decision

The dedicated Herdr platform job, its preparation and independent cleanup
scripts, fixtures and their tests are removed before their remaining source
consumers. The selected CLI gate still requires the ordinary, installed and
runtime jobs to succeed. Their platform matrices, coverage thresholds and real
process-exit and ownership checks remain in place. SQL resources still used by
source and build remain packaged until their actual consumers are removed.

This supersedes the platform-fixture portions of the [frozen launch decision](../architecture/2026-11-12-herdr-frozen-tool-launch.md),
[partial workspace evidence](2026-11-13-herdr-partial-workspace-evidence.md),
[process incarnation capture](2026-11-14-herdr-process-incarnation-capture.md)
and [Windows cleanup test budget](2026-11-15-windows-cleanup-mechanism-budget.md).
Their original evidence and rationale remain historical.

## Alternatives

**Keep the dedicated platform suite until all Herdr source is gone.** Its test
entry points retain consumers of the code being removed, preventing the planned
consumer-first deletion and continuing to install an unsupported runtime.

## Consequences

CI no longer validates real Herdr execution or proves its cleanup. Existing
Herdr tasks and resources remain the user's responsibility; removing validation
is not evidence that they stopped. Ordinary retained capabilities continue to
use their existing checks, and subsequent source removal must account for its
own remaining consumers.
