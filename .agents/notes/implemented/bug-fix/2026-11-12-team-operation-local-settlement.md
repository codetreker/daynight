# Agent Note: Team Operation Local Settlement

Status: implemented

## Problem

Team management and Project transfer can receive a write outcome while identity
admission prevents publication. Holding the local operation and its promise until
admission resumes leaves the interface busy indefinitely during a lasting pause.
Finishing locally also permits later edits or navigation before the old result is
published. Cancelling a dispatched request cannot establish that the server
rolled back the write.

## Decision

The existing shared operation owner records actual dispatch and a trusted receipt,
and settles local pending and the caller's promise after outcome classification
without waiting for presentation admission. A dispatched write without confirmation
remains unknown; a trusted confirmation, known refusal and cancellation before
dispatch retain their respective classifications. Publication, installation and
subsequent reads remain bound to the original identity, resource and operation and
wait for admission; the local result classification can be shown without remote
details while admission is closed. The owner cancels delayed work on replacement
or disposal and receives its errors. Publication failure remains separate from a
confirmed write: a failure before the callback starts can be explicitly retried,
but a callback that may have partially run is not automatically repeated. The
existing editor, draft revision and navigation checks
protect newer interaction from destructive effects of an old completion. Team
owners remain retained while publication is pending or failed, independently of
local pending. A confirmed invitation blocks another invitation submission until
its one-time result is published. Admission waits use the pause revision to
distinguish a transient pause and recovery from a lifecycle failure. The
[authentication design](../../../../docs/design/daynight-auth.md) describes the
current consumer contracts.

The [Team form decision](2026-11-11-team-late-presentation.md),
[member result decision](2026-11-11-team-member-result-ownership.md) and
[transfer decision](../feature/2026-11-05-web-project-transfer.md) retain their
presentation ownership and the reasons for those checks. Transfer preparation
uses the operation cancellation signal for scope, cache and access waits; confirmed
receipt cleanup has a separate owner and cancellation lifetime, and a cleanup
failure can be retried without resubmitting the transfer.

## Alternatives

**Wait for admission before settling.** A persistent pause can hold pending and
the caller's promise indefinitely after the write outcome is known or cancelled.

**Use a general mutation and form framework.** Existing consumers own their
resources, editor instances and navigation checks; a broader framework adds a
contract without providing those owner-specific protections by itself.

## Consequences

Local editing can continue without granting permission for a remote operation.
A temporary admission recovery can publish the same confirmed result without
clearing a newer draft or taking over navigation. An unknown write is not replayed,
and a later read cannot recover its original receipt. This change retains the
existing temporary admission gate and does not enable account-change sticky pause.
