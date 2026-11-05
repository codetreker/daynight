# Agent Note: Stable Discussion Details During Background Checks

Status: implemented

## Problem

A background identity check or hidden document cancels Discussion reads. Closing
the message dialog at the same time loses its reading position and disrupts
focus, even when the account, permissions and messages are unchanged. Retaining
the interface must not let stale reads or writes cross the admission boundary.

## Decision

Temporary document visibility and admission changes cancel reads and invalidate
their tickets without retiring the displayed message details or page memory.
The same native dialog retains its keyboard layer and parent isolation throughout
the check, and an initialized composer permits local draft editing. Actual task or
account retirement and explicit closure keep their cleanup semantics. Reads, writes and confirmed response publication still require
their existing admission and scope checks; dispatched posts are never replayed.
The [Discussion design](../../../../docs/design/task-thread-web.md) owns the
mechanism, and the [workspace decision](2026-11-05-stable-workspace-during-identity-checks.md)
owns the shared presentation and admission policy.

## Alternatives

**Close and reopen the dialog on every check.** This releases focus and parent
isolation but loses the native dialog and reading state during an ordinary return.
Actual retirement already provides the necessary cleanup when access is lost.

## Consequences

Existing details remain readable during a check while new requests and results
wait for admission. Same-data recovery preserves local interaction state; real
changes and failures retain their normal behavior. The retained dialog continues
to own its keyboard layer until the user closes it or its scope retires.
