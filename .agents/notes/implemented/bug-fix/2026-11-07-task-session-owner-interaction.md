# Agent Note: Task Session Interaction Belongs to Its Owner

Status: implemented

## Problem

Project access allows collaborators to inspect task execution, but shared access
must not let another participant send messages, answer native approvals or change
the running Agent. The relay's administrator exception gave project administrators
those operations in another user's Session. Checking only new submissions would
also leave previously admitted operations, reconnection work and terminal leases
able to use that exception.

## Decision

Task Session reads continue to require a valid credential and current project
access, including Team inheritance. Execution interaction additionally requires
the authenticated actor to equal the owner recorded on the Session. Project roles
and the current Task assignee do not substitute for that identity. Web uses the
persisted `owner_user_id`; Herdr uses the same stored owner and immutable terminal
owner metadata. Registration already binds that identity to the original claim,
so the rule requires no new owner field or data migration.

The shared admission path separates project access from owner interaction. Web
submission, offer, `operation_begin` and reconnection reconciliation recheck the
original actor. Herdr submission, dispatch, active lease checks and durable ACK
processing do likewise. An old non-owner operation cannot progress through the
administrator exception, and an old non-owner lease or delayed ACK cannot restore
control. Controller and Worker protocol authorization remains independently bound
to the original execution owner.

Permission projection preserves readable content and the Provider's catalog.
For non-owner readers it disables Web operations and mutable settings/available
commands, and clears terminal control actions. Native browser clients also carry
the verified claim owner; terminal clients use the validated owner identity. The
view separates interaction permission from lifecycle so a read-only collaborator
still receives the live timeline, history, resources, display preferences and
fullscreen reading without switching to an unfinished archive.

The [Task Session requirements](../../../../docs/spec/task-sessions.md#基础会话交互)
own visible behavior, and the [relay design](../../../../docs/design/task-session-protocol.md#relay-与恢复)
owns authorization and projection. This narrows the administrator interaction
exception within the original [claim-frozen Session model](../../archived/architecture/2026-10-27-task-session-mode-contract.md)
while retaining its mode and execution identity. The active
[Herdr view decision](../architecture/2026-11-05-herdr-session-web.md) retains its
observation, lease and immutable recording mechanisms.

## Alternatives

**Disable controls only in the browser.** Direct API calls, old browser clients
and previously admitted operations would still execute under the relay's
administrator exception. Server admission and dispatch therefore enforce the same
owner rule.

**Add owner metadata to the native wire snapshot.** The stored Session already
owns the authoritative identity, and the browser has a validated claim owner.
Changing the strict shared snapshot would add producer and consumer coordination
without improving server authorization. Existing permission projection and the
claim binding supply the required browser gates.

## Consequences

Collaboration retains current project reading permissions while only the Session
owner can affect native execution. An owner demoted to project member can still
interact while project access remains valid; losing project access or the actor's
credential still prevents interaction. Independent Test/Bot ownership and Task,
Thread, Step and Worker claim management retain their own rules.

Both backends require coverage of new command rejection and reauthorization of
existing work. Browser checks must preserve live reading while denying every
interaction, including terminal control actions and pending native requests.
Provider capabilities, wire formats and archive identities remain unchanged.
