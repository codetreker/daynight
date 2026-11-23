# Agent Note: Settle Project Deletion During Admission Pauses

Status: implemented

## Problem

A Project deletion can receive a trustworthy server receipt while identity
admission is paused. Waiting for admission before settling the local operation
can leave its promise and pending state held indefinitely. Applying the receipt
immediately can remove displayed content or navigate away while the user is
editing or has moved to another route. A cancelled request also cannot establish
whether the server committed it.

## Decision

The existing deletion operation and result owners retain the original user,
Project, operation, dispatch and receipt facts. They settle the local operation
without waiting for presentation admission, preserving confirmed, rejected,
undispatched and dispatched-but-unknown outcomes. Publication and cleanup
remain subject to the original identity and resource admission. Withdrawal uses the original admitted cache generation even if the presentation
has changed. Dialog closure and navigation still require the submitted editor
revision and location to match. The [settings workspace decision](../architecture/2026-11-13-project-settings-workspace.md) separates section presentation from this security cleanup. If persistent cleanup fails after
withdrawal, retry checks the original user, Project, user fence and denied
generation without requiring the same ticket object or sending a second
withdrawal notification; a stale ticket cannot clear a newer generation.
The owners hold and cancel delayed publication on replacement or disposal.
The [Web design](../../../../docs/design/daynight-web.md#项目删除) owns the
complete interaction. This refines the immediate withdrawal in the original
[Web deletion decision](../feature/2026-11-06-web-project-deletion.md).

## Alternatives

**Wait for admission before settling the operation.** A permanent pause can keep
pending state and the original promise alive indefinitely, even when the receipt
has already established success.

**Withdraw immediately on a confirmed receipt.** This makes local cleanup and
navigation alter retained display during a pause, and an older completion can
interfere with newer user activity.

## Consequences

A confirmed receipt survives local publication or cleanup failure, and an
unknown dispatched deletion is not replayed. A temporary pause can later release
the same result; until admission returns, it does not start cleanup, reads or
navigation. Generation checks leave newly admitted content intact, while editor checks protect newer presentation. This
decision applies to Project deletion, not other operation owners.
