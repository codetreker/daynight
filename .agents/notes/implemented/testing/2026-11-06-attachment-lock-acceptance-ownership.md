# Agent Note: Attachment Lock Acceptance Ownership

Status: implemented

## Problem

A real admitted attachment write and a concurrent project membership removal
need a test of their database ordering. A browser authentication journey also
needs to prove its visible authority and installed CLI behavior. Keeping the lock
observer and paused upload in the browser harness couples those separate proofs
to the same PostgreSQL and process lifecycle, making their ownership and failures
harder to assess.

## Decision

The Go built-binary E2E suite owns the attachment mutation and direct grant
removal race. It admits a real HTTP upload, observes the exact grant waiter and
attachment transaction blocker in isolated PostgreSQL while the body is incomplete,
then verifies upload, removal, subsequent denial, retained bytes and cleanup.
The Web combined authentication journey retains its normal browser and installed
CLI authentication, upload, membership withdrawal and visible resource checks.
It does not pause an upload or inspect attachment database locks. Each native and
container target requires ten combined checks.

The [original combined acceptance decision](../../archived/testing/2026-10-23-authentication-combined-acceptance.md)
records why the installed client, real browser, transport and restart were tested
together under the original admission contract. The [attachment serialization decision](../architecture/2026-11-06-attachment-task-deletion-serialization.md)
and current authentication design own the changed transaction behavior. The
[server guide](../../../../packages/daynight-server/README.md) and
[Web guide](../../../../packages/daynight-web/README.md#production-browser-acceptance)
own the current validation commands and inventories.

## Alternatives

**Keep the database lock observer in the Web journey.** It could observe the same
race alongside the browser, but would keep server transaction evidence coupled to
browser process, container and page timing. The Go built-binary fixture can prove
the HTTP and database ordering directly while the Web journey retains its own
visible behavior.

**Replace the lock wait with a mocked or timed delay.** A delay cannot establish
which transaction waits for the intended grant or that the upload holds the lock.
The isolated PostgreSQL observation identifies both real transactions before the
body is released.

## Consequences

Server ordering and browser/CLI behavior now have separate evidence and failure
ownership. The Web journey no longer claims the original paused-upload or socket
interruption proof. Both suites remain required for their respective outcomes;
a focused dirty overlay run cannot substitute for the clean combined CI result.
