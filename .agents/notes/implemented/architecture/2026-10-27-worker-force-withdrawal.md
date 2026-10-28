# Agent Note: Worker Force Withdrawal

Status: implemented

## Problem

A task can retain an active claim while its worker is paused, disconnected or
unavailable to an operator. Task details need to identify the current execution,
and an authorized operator needs to return that task to manual control without
access to the source machine. Resetting status and automatic permission through
separate writes would leave a window for another automatic acquisition. A lost
response must not cause another ownership mutation.

## Decision

The [claim protocol](../../../../docs/design/daynight-worker-claims.md) exposes
`POST /worker-claim/withdraw` with the reviewed `version` and `claimId`. A current
project member who is the claim's original owner or a project admin may withdraw
an active or released claim. Completed history and null have no current claim to
withdraw. The same project transaction clears `worker`, returns the task to
`todo`, clears both execution timestamps and sets `allowAgents=false`. It preserves
other task materials and increments the task version once. It requires no
`stoppedConfirmed`, target descriptor or source-machine access.

The original worker discovers the claim's absence through its existing complete
own-claim inventory and performs terminal resource cleanup. Withdrawal does not
guarantee immediate process stopping or revoke external credentials. Closing
automatic permission prevents immediate automatic reacquisition; manually
starting another execution remains an explicit operator decision. A completed
withdrawal clears the last server-side claim record, while local execution
history retains its original identity.

Web task details share the claim display and withdrawal operation across the
dialog, standalone page and fullscreen. The display identifies the claiming user,
machine, agent and phase. Released records are labeled; completed records do not
appear as current ownership. Project members supply readable identities, while a
former member remains identified by its real user ID. Confirmation freezes the
task, claim and exact version and explains the reset and delayed-stop boundary.
The existing task session owns submission, returned-resource validation and
GET-only reconciliation after an uncertain result. Cancel submits nothing, and
known changes invalidate the review. Button visibility supplements the service's
membership and owner/admin checks. The heading containing claim information is
a bounded, focusable scroll owner in normal and fullscreen, dialog and standalone
views. Its size reserves tabs and reading space even for long names, accounts,
machine descriptions or member errors; short claimed views hide the informational
footer and reuse compact tabs and attachment chrome. Short claimed standalone
pages compact their auxiliary navigation spacing to keep complete return and
language controls on one row at 320px in either language, preserving reader space.
Full identity strings and
withdrawal controls remain reachable by keyboard
without collapsing Overview or attachment reading.

Transfer's HTTP endpoint, typed operation, CLI command, target descriptors and
runtime submission paths are removed. This partially supersedes the
[claim foundation](2026-10-24-worker-claim-foundation.md) and
[manual-control decision](2026-10-27-worker-manual-control.md). Release still
confirms source stopping before returning a retained released record; resume
still creates fresh claim/worktree identities and native execution. Claim IDs
continue to distinguish execution generations.

The current [six-column record model](../simplification/2026-10-27-worker-claim-records.md)
retains claim/native-session identity and derives cleanup from complete inventory
and actual resources. It has no transfer controls or old-schema migration. The
following records the local retirement handling originally delivered with force
withdrawal, before the detailed local store was replaced.

### Original detailed-store retirement

Schema 4 migrates old transfer controls out of the
[local records](2026-10-26-worker-local-records.md). An unfinished source retains
its terminal cleanup responsibility and original deadline; a missing terminal
cleanup is materialized from the original request time with a ten-minute bound.
Cleanup persists claimEnded, so known ownership-end proof survives restart and
offline cleanup. Existing terminal cleanup without a control or with a confirmed
control migrates that fact as true; pending controls and shutdown begin false.
The row pauses ordinary recovery and clears retry authorization. Migration makes
no remote write and does not replay an unknown transfer. If the source claim
already ended, normal inventory reconciliation completes source cleanup. If it
remains current, the operator uses Web force withdrawal. Completed rows only
lose the obsolete control shape. Pending source rows with cleanup can still own
actual Git/Herdr/native resources. After the original worktree is verified, its
binding and active status commit atomically under the existing one-active index,
allowing the normal resource association checks to finish cleanup. A conflict
rolls back both changes. The original identity, deadline, cleanup progress and
claimEnded proof remain; this path never launches an agent or reserves active
status for a resource-free pending source.

## Alternatives

**Keep transfer as an operator recovery path.** Transfer needs a target member,
worker, machine, agent and fresh resource identities, and it coordinates source
cleanup with uncertain target acquisition. Returning a task to manual control
does not require granting a target execution. Withdrawal removes that protocol
while retaining ordinary explicit resume and future automatic selection.

**Require confirmed stopping for every reset.** Release already provides that
contract. Requiring a reachable source or a stopping proof would prevent an
operator from withdrawing an unavailable worker's claim. Force withdrawal
accepts the delayed-stop limitation and makes it visible before submission.

**Set todo and disable agents through ordinary mutations.** The active-claim
state guard rejects ordinary status reset, and separate permission/status writes
cannot atomically remove ownership. One versioned ownership operation preserves
the reset across concurrent changes.

**Replace retired transfer intent with a local-only stop or withdrawal control.**
The original detailed-store implementation kept ownership-end proof in
cleanup.claimEnded rather than adding another control variant. That preserved
its stronger cross-restart cleanup guarantee while removing transfer intent.
The six-column simplification subsequently removes both stored forms and the
migration: each process obtains its own complete inventory before selecting
terminal cleanup. It retains the force-withdrawal protocol and delayed-stop
boundary without an alternate local management journal.

## Consequences

Operators can see who holds a task and restore manual control from Web. The
service keeps authorization, claim fencing, reset timing and automatic-selection
permission in one transaction. Reconciliation and resource cleanup reuse their
existing owners, without target preparation, file transport or a second local
control protocol.

A withdrawn agent may still have a live process and external credentials until
its worker observes the change and stops it. The confirmation makes that limit
part of the deliberate operation. Removing transfer is a protocol change;
callers using its route or command must update. Attributed local resources remain cleanup responsibilities, and an unavailable
worker can leave them until it resumes. Complete native and cross-platform qualification
remains separate from service, frontend and controlled runtime tests.
