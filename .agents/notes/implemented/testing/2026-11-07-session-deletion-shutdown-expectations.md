# Agent Note: Session Deletion Shutdown Expectations

Status: implemented

## Problem

A deletion test can observe both WebSocket clients closing before the server
finishes their deferred disconnect transactions. Those transactions recheck
Project liveness and refuse the deleted scope with `not_found`. When fixture
shutdown begins before the callbacks finish, the relay retains that refusal as
a completed drain error. The same successful deletion can therefore pass or
fail according to cleanup scheduling. The failure in [run 42340804888](https://github.com/codetreker/daynight/actions/runs/42340804888/job/128308801718)
was reported by fixture shutdown after the deletion and channel assertions.

## Decision

The domain Session HTTP fixtures share mutable shutdown expectations and the
bounded application cleanup callback. A scenario may declare the exact clean
domain fault caused by its own successful state transition. Project deletion
channel tests declare `not_found` after the deletion response succeeds. Their
Worker and browser closure assertions remain required.

The matcher traverses completed-drain wrappers and joined errors. Every cause
must be the selected domain fault with no underlying cause; database failures,
timeouts, other fault codes and unfinished-drain errors remain failures. The
fixture cleanup reads the current expectation rather than a copy captured when
the fixture was created.

Production Session admission and drain error propagation retain their existing
behavior. The [application lifecycle decision](../architecture/2026-11-06-server-application-lifecycle.md)
owns dependency shutdown ordering. The [module validation guide](../../../../packages/daynight-server/README.md#http-scenario-ownership)
owns the fixture contract and scenario layout.

## Alternatives

**Filter `not_found` from production shutdown.** A global filter cannot establish
that each refusal came from an intentional deletion, and checking only one cause
can discard a database or timeout failure in the same error tree.

**Wait until the sockets close.** This is already the deletion test's observable
requirement. Socket closure does not acknowledge completion of the server's
subsequent disconnect transaction, so additional client reads do not establish
the missing ordering.

**Add a delay before fixture shutdown.** A delay changes the likelihood of the
race without acknowledging the legitimate deletion refusal. Runner load can
still push cleanup beyond that delay.

## Consequences

Both legal cleanup orders satisfy the deletion test without weakening product
error handling. Shared cleanup state gives Web and Terminal fixtures the same
explicit expectation contract. Regression tests cover late configuration and
error combinations so an unexpected cause cannot be accepted merely because
`not_found` is also present.

An expected clean refusal is specific to the scenario that caused it. Other
fixtures continue to fail on shutdown errors unless they declare their own
precise expectation. This change does not make production disconnect after
Project deletion a successful business operation.
