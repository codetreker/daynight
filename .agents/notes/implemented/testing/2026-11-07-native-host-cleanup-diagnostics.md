# Agent Note: Native Host Cleanup Failure Diagnostics

Status: implemented

## Problem

The native assistant-host test reports provider availability and total elapsed
time, then removes its isolated directory. If Windows rejects that removal with
`EBUSY`, the availability summary does not identify which metadata command ran,
when its direct process and streams closed, or whether the underlying issue
contained unconfirmed command cleanup. A directory-removal failure alone cannot
attribute the open directory reference to an owned process or an external actor.

## Decision

The test uses the collector's existing command injection point to call the same
Herdr command runner, with the same operation and `cleanupWithinDeadline` option.
An observing spawn wrapper forwards the original executable, arguments and
options unchanged. It retains only the executable basename, allowlisted metadata
arguments, PID and relative creation, spawn, error, exit and close event times.
It neither terminates processes nor adds process ownership claims.

Only a failure of the original directory removal emits the collected metadata.
The report includes provider issue error structure and the existing historical
cleanup-failure and current cleanup-confirmation classifications. Error structure
is bounded by depth, node count and aggregate fan-out. Incomplete error traversal
produces unknown cleanup classifications rather than recursively inspecting an
unbounded graph. Probe and argument retention also have explicit limits.

The report omits environments, working-directory paths, arbitrary arguments,
error messages, stack traces and command output. The original cleanup error is
re-thrown even if producing the diagnostic fails. Removal still runs once, and
all native probe deadlines and existing assertions remain unchanged.

## Alternatives

**Retry deletion or extend the probe budget.** Either changes the observed failure
before its cause is understood. Neither establishes which process or service held
the directory open.

**Treat direct closure as proof of the directory lock owner.** Direct process and
stream closure narrows the lifecycle evidence but does not identify a surviving
descendant or an external directory handle. The diagnostic makes no such claim.

**Add a machine-wide handle inspection tool.** Identifying directory-handle owners
would require additional tool availability and privileges. That is a separate
diagnostic step if the retained command observations remain insufficient.

## Consequences

A cleanup failure preserves the command and direct-close context needed for a
narrower investigation without changing production process handling or the test's
pass criteria. Structured metadata cannot by itself prove why a probe timed out,
identify the Windows directory lock owner, or confirm arbitrary descendant exit.
Controlled tests verify transparent spawning, single-attempt cleanup, original
error preservation, bounded reporting and omission of private input and output.
