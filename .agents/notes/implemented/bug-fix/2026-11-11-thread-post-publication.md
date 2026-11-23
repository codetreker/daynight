# Agent Note: Settle Thread posts before publication admission

Status: implemented

## Problem

A Thread POST can be confirmed while account admission prevents its message
from being displayed. Waiting for that admission in the send operation holds
the local pending state indefinitely and can obscure the known remote result.
Late completion can also clear a draft after the user edits or navigates away.

## Decision

The Thread controller records dispatch and a validated receipt under the original
operation and settles the send independently of publication. Preparation has an
operation-owned cancellation signal. The controller retains the confirmed
receipt and owns cancellable publication until admission resumes or the
controller retires. Publication checks the original controller, account scope,
editor revisions and submission navigation context before destructive draft
or reply cleanup. A dispatched but unconfirmed result remains unknown.

## Alternatives

**Hold the send until publication.** This preserves the receipt but leaves the
promise and busy state dependent on a gate that may never reopen.

**Replace an unpublished receipt with a new send.** This permits another write
but loses the first confirmed resource if its publication has not completed.
The controller instead permits editing while retaining the receipt and reserves
the next send until publication succeeds or the controller retires.

## Consequences

Temporary admission blocking preserves rows, replies and drafts without replay;
the same receipt can be published after admission returns. A publication failure
remains a read/admission error with a confirmed remote outcome. Controller
retirement cancels its waiter, and a pending confirmed receipt does not authorize
a second POST. The [original Thread decision](../../archived/architecture/2026-11-03-task-thread-web.md)
records the earlier scope and receipt design; the [Web design](../../../../docs/design/task-thread-web.md)
owns the current mechanism.
