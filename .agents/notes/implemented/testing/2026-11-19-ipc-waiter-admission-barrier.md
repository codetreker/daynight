# Agent Note: Observe authenticated IPC waiter admission

Status: implemented

## Problem

The Controller IPC capacity regression opens 32 independent connections for the
same pending initial input. Its first native send proves dispatch began, but
does not prove that the other connections delivered authenticated frames or
registered their response waiters. A subsequent capacity probe can therefore
be admitted and wait for native acceptance, exceeding the test deadline.

The [Windows failure](https://github.com/codetreker/daynight/actions/runs/44478109927/job/135417704358)
records a 5,039 ms timeout and an `EBUSY` while deleting the fixture journal.
It does not identify the stalled phase or the file-handle owner. The missing
admission barrier is a reproducible test defect; attribution of that historical
timeout and cleanup failure remains unconfirmed.

## Decision

The [IPC integration fixture](../../../../packages/daynight/test/commands/controller/runtime-ipc.integration.test.ts)
observes real server sockets through their admission timeout, authentication
timeout reset and subsequent waiter close-listener registration. It waits for
all 32 registered waiters before expecting capacity rejection. Socket callbacks
and their identities retain their production behavior.

The same bounded behavior runs with concurrent frames and a controlled schedule
that corks 31 duplicate client frames. The controlled schedule proves that the
first send can coexist with only one waiter and that a later probe is admitted.
It cancels and drains that probe, releases the held frames, then checks the
actual capacity limit, observation responsiveness, single native dispatch and
single provider close.

Finalization releases native input, aborts and joins owned requests, destroys
client sockets and joins the Controller before the outer fixture deletes its
SQLite directory. Successful shutdown also checks zero remaining waiters and
closed server sockets. Both schedules retain the default test deadline.

## Alternatives

**Infer ordering from connection creation.** Independent socket data events do
not have a global FIFO guarantee. A later connection can submit its complete
frame before an earlier connection.

**Increase the test timeout.** An admitted probe waits on native acceptance that
the test deliberately withholds until stop. More time cannot establish the
missing capacity precondition.

**Expose waiter counts through production observation.** The fixture can observe
the existing real socket lifecycle without extending the public protocol or
adding runtime instrumentation solely for a test.

## Consequences

The regression checks admission rather than scheduler speed, retaining real
Windows named pipes, authentication and SQLite. Its observer depends on the
runtime's post-authentication waiter registration point; changes to that
lifecycle require updating the fixture. The controlled schedule demonstrates a
specific failure mechanism without claiming it explains an uninstrumented
historical run. No runtime capacity, protocol or timeout policy changes.
