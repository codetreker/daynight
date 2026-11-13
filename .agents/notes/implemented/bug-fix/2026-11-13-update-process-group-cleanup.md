# Agent Note: Confirm Update Process Group Cleanup

Status: implemented

## Problem

An update subprocess can exit while descendants in its inherited POSIX process
group continue running. Requesting a group signal and observing the direct child
close do not confirm that those descendants or captured output streams have
finished. Reusing an exited leader's numeric process group ID for a later signal
can also affect an unrelated group.

## Decision

POSIX update commands run under an invocation-owned session anchor. The anchor
starts the command in its group, conveys its outcome and output, and sends a
single destructive signal to its own group when cleanup is requested. Its source
is loaded before npm can replace the installation; the anchor does not inherit
`NODE_OPTIONS`, while the command retains its environment.

The parent confirms cleanup only after the anchor exits, captured output streams
close, and a non-destructive group existence check reports `ESRCH`. Observation
errors, lost IPC, open streams or a group still present at the fixed 10-second
deadline produce a cleanup-unconfirmed error retaining the original failure. A
reused group ID can prevent confirmation, but the parent never sends a destructive
signal to it. Windows retains attached console handles and `taskkill /PID /T /F`.

## Alternatives

**Signal the saved group ID after the direct child exits.** The number can be
reused after the original group disappears, so a destructive signal could target
another invocation.

**Treat signal request or direct child closure as completion.** Neither proves
the remaining group members and captured streams have finished. The earlier
[skill refresh decision](../../archived/feature/2026-10-24-update-installed-agent-skills.md)
established inherited group cleanup without this completion observation.

## Consequences

Confirmed cleanup covers the invocation's inherited group and captured streams,
not descendants that deliberately leave the group, arbitrary asynchronous I/O,
or durable storage. A conservative observation can fail even after the original
group has stopped, including when its numeric ID is reused. The anchor adds a
process and IPC protocol, but retains command outcome and output semantics.
