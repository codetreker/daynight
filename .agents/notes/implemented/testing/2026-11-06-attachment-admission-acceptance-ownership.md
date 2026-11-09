# Agent Note: Attachment Admission Acceptance Ownership

Status: implemented

## Problem

An admitted attachment write and a concurrent project membership removal need
an observable ordering across authorization, file IO and subsequent access. A
browser and CLI have their own authority and presentation boundaries. Keeping
the database observer and paused upload in the browser harness coupled those
proofs to the same PostgreSQL and process lifecycle, making their ownership and
failures harder to assess.

## Decision

The Go startup/shutdown test
`TestAttachmentGrantRevocationWithFreshProcess` owns
the admitted attachment mutation and direct grant removal race. It admits a real
1 MiB HTTP upload and keeps its body incomplete while Project member DELETE
completes with 204. New project access returns 404 before the body is released;
the already admitted upload then returns 201. The test verifies revoked access
to the attachment after upload completion: the [target gate](../architecture/2026-11-06-attachment-target-gate.md)
serializes a read of that same path with the upload, so a synchronous read cannot
finish while the body is held. It verifies the uploaded bytes and owned-resource
cleanup against isolated PostgreSQL and the real service. Its UniAuth fixture uses bounded process cleanup;
forced termination reports the missed graceful deadline, and an unconfirmed
service or database-session cleanup retains the guarded gateway and its directory.
An unconfirmed gateway exit also fails cleanup and retains that directory.
The module gate explicitly tests the fixture cleanup guard, while the independent
[startup/shutdown gate](2026-11-09-independent-go-startup-shutdown.md) executes the
real command process witness. Web module tests and
independent browser fixtures exercise presentation and local behavior with controlled responses;
they do not establish installed-CLI or live-service integration. The former
Web combined runner, including its ten-check native/container receipts, was
removed. Its results remain historical evidence for their tested source.

The [original combined acceptance decision](../../archived/testing/2026-10-23-authentication-combined-acceptance.md)
records why the installed client, real browser, transport and restart were tested
together under the original admission contract. The [attachment serialization
decision](../architecture/2026-11-06-attachment-task-deletion-serialization.md)
retained Task and authorization-source locks through mutation completion; under
that condition, a grant DELETE had to wait for the upload. The later [attachment
admission decision](../bug-fix/2026-11-06-attachment-admission-locks.md) keeps the
Task lock but reads authorization without holding source locks through file IO.
The current process test therefore proves that grant removal completes while the
admitted upload is still open, rather than expecting a grant-lock waiter.

The [server guide](../../../../packages/daynight-server/README.md) and
[Web guide](../../../../packages/daynight-web/README.md#independent-browser-checks)
own the current validation commands and their limits.

The grant witness receipt records readiness separately from the child Wait
result, exit code and signal. Process facts are read only after the Wait
goroutine closes its completion channel. Startup diagnostics inspect at most
the first 64 KiB of captured output and publish at most four failures using
fixed component, phase, cause and detail values. Unknown text, extra JSON fields,
addresses and raw diagnostics are not published; ignored and truncated input
remain explicit. The private full capture retains the existing secret check,
registered before startup so early failure also runs it. These observations do
not replace the original assertion or cleanup outcome.

## Alternatives

**Keep the database observer in the Web journey.** It could observe the same
race alongside the browser, but would keep server transaction evidence coupled to
browser process, container and page timing. The Go built-binary fixture proves
the HTTP ordering against PostgreSQL; Web's independent checks retain their own
controlled-fixture scope.

**Replace the historical lock wait with a mocked or timed delay.** A delay cannot
establish which transaction waits for the intended grant or that the upload holds
the lock. After the authorization-source locks were removed, the current test
instead observes successful removal and denied new access while the admitted
body remains incomplete.

**Publish child output directly.** Lifecycle output can contain listener
addresses, and runtime failures can include arbitrary text. A fixed-value
projection preserves useful startup categories without exposing those values.

**Retry startup or extend readiness after an unexplained exit.** Neither action
establishes why the child exited. The witness retains the failure and records
the available classification instead of changing its startup policy.

## Consequences

Server ordering and Web presentation have separate evidence and failure
ownership. The removed Web runner no longer provides current-source combined
browser/CLI, paused-upload or socket interruption proof. A focused dirty
overlay run cannot substitute for clean module CI evidence, and controlled Web
fixtures cannot establish full-stack behavior. The default Go coverage
configuration does not enable race instrumentation; when race is required, the
separate test uses its race build tag for the fresh server build and checks that
binary's build information. An explicit source overlay must be supplied through
`GOFLAGS` so the child build inherits it.
The diagnostic window can miss a later error, and non-JSON exits remain
unclassified; exit facts and truncation markers preserve those limits. A later
passing run cannot establish the cause of an earlier unclassified exit.
