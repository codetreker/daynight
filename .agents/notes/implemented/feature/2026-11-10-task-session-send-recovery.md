# Agent Note: Task Session Send Recovery

Status: implemented

## Problem

A caller sending to an observed Task Session can lose the response or exit after
the service accepts the message. Resolving the current Session again can target
a different execution or turn, while treating a missing receipt as proof of no
send can duplicate an operation. Project access also does not establish Session
ownership, and an accepted operation can outlive its original credential rights.

## Decision

The [requirements](../../../../docs/spec/task-session-send.md) define explicit
targeted ordinary messages and original-operation recovery; the
[design](../../../../docs/design/task-session-send.md) owns persistence and
authorization. Sending consumes the shared
[observation capability](2026-11-10-task-session-observation.md), then reuses the
existing Submit intent and dispatch rules.

The CLI stores an actor/origin-isolated private record before its first POST and
durably marks the dispatch uncertain before network activity. Any retained
record permits only an original-operation read after target and body-hash
verification, including a record left before actual dispatch. Records contain
identity, hashes and bounded operation facts rather than message bodies or
credentials. Real file and directory barriers precede the request.

Execution identity and expectedTurnId remain the command preconditions.
connectionEpoch is retained as an inspection observation, not added to the
existing command wire. Historical receipt reads preserve their original Session
after a new claim and do not restore a command queue. OAuth is admitted by Task
purpose, with the original Actor reauthorized before dispatch.

## Alternatives

**Reobserve current after interruption and resubmit.** A new claim or turn can
make the same text a different intent. A successful current read cannot establish
what happened to the original request, so recovery keeps its frozen identity.

**Keep only an operation ID in memory.** Process exit would destroy the target
and intent evidence precisely when a response is unknown. A minimal private
record supports recovery without persisting user text or credentials.

**Treat prepared or not_found as permission to send.** A process can stop between
any local or network stage, and absence is not a historical submission receipt.
The retained record deliberately favors avoiding duplicates over automatic
progress through an uncertain outcome.

**Skip filesystem guarantees on a platform lacking POSIX mode semantics.** That
would silently weaken the pre-dispatch record. Windows uses native private ACL
and synchronization mechanisms; failures stop before dispatch on every platform.

## Consequences

Callers retain a usable original identity through network and process failures.
The trade-off is that an operation recorded as unknown may never have reached
the service; the CLI still will not automatically resend it. Cross-machine
recovery requires explicit original resource IDs because a current observation
cannot reconstruct the old intent.

Private persistence requires actual filesystem support and introduces native
Windows permission and synchronization code. Failed local receipt saving or
output does not undo a service commit, so output must preserve the known result
and original identity independently of local success. Service acceptance,
Provider acceptance and completion of the requested Agent work remain separate
facts.
