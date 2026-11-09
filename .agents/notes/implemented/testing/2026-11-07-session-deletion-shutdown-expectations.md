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

A Session HTTP scenario may declare the exact clean domain fault caused by its
own successful state transition. Project deletion channel cases select
`not_found` after deletion succeeds; Worker and browser closure assertions remain
required. Cleanup reads the current expectation, including one configured after
the fixture was created.

The matcher traverses completed-drain wrappers and joined errors. Every cause
must be the selected domain fault with no underlying cause. Storage failures,
timeouts, other fault codes and unfinished-drain errors remain failures. An
expected refusal does not acknowledge a pending callback or erase its lifetime.

The initial implementation shared mutable expectations with the bounded
application cleanup callback. The
[Session HTTP use-case decision](2026-11-09-session-http-use-cases.md)
replaces that full-application dependency with actual routes and direct service
operation mocks. Current cleanup drains routes, verifies background disconnect
completion and validates expected calls. The same exact cause matcher handles
an explicitly supplied intentional refusal. Normal shutdown permits post-drain
HTTP `429` checks; fixture cleanup releases the remaining request lifetime.

Production Session admission and drain error propagation retain their behavior.
The [application lifecycle decision](../architecture/2026-11-06-server-application-lifecycle.md)
owns application dependency ordering; the
[module validation guide](../../../../packages/daynight-server/README.md#session-http-tests)
owns the current fixture contract and scope.

## Alternatives

**Filter `not_found` from production shutdown.** A global filter cannot establish
that each refusal came from an intentional deletion. Checking only one cause
could discard a database or timeout failure in the same error tree.

**Wait until the sockets close.** This is already the deletion test's observable
requirement. Socket closure does not acknowledge completion of the server's
subsequent disconnect callback, so more client reads do not establish the
missing ordering.

**Add a delay before fixture shutdown.** A delay changes the likelihood of the
race without acknowledging the legitimate deletion refusal. Runner load can
still push cleanup beyond that delay.

## Consequences

Both legal cleanup orders satisfy the deletion test without weakening product
error handling. Native and terminal fixtures share the explicit expectation
contract. Regressions cover late configuration and error combinations so an
unexpected cause cannot be accepted merely because `not_found` is also present.

An expected clean refusal is specific to the scenario that caused it. Other
fixtures retain shutdown errors unless they select their own precise expected
cause. Production disconnect after Project deletion remains a refused business
operation; the fixture records the intentional cause and still drains it.
