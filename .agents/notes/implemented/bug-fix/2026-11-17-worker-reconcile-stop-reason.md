# Agent Note: Worker Reconcile Stop Reason

Status: implemented

## Problem

A reconcile wake can cancel a timer immediately before the Worker stops. The
timer's rejection may be handled after both signals abort, carrying the wake
reason instead of the Worker stop reason. The runtime identifies normal Worker
stops by reason identity, so the stale timer error appears as a Worker failure.

## Decision

When a reconcile wait rejects, an aborted Worker signal takes precedence and
its original reason is propagated. A wake alone completes the wait normally;
an error without either cancellation remains an error. This rule belongs to the
reconcile wait and does not change the separate terminal selection or network
authentication cancellation responsibilities.

## Alternatives

**Accept any abort error as a Worker stop.** A wake or unrelated abort would
then be indistinguishable from the Worker's own stop and could conceal failures.

## Consequences

The runtime retains its identity-based stop classification even when wake and
stop race. A stop observed while handling another timer failure takes precedence;
without a stop or wake, the original timer failure remains visible.
