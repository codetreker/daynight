# Agent Note: Attachment Admission Acceptance Ownership

Status: implemented

## Problem

An admitted attachment write and a concurrent project membership removal need
an observable ordering across authorization, file IO and subsequent access. A
browser authentication journey also needs to prove its visible authority and
installed CLI behavior. Keeping the database observer and paused upload in the
browser harness couples those separate proofs to the same PostgreSQL and process
lifecycle, making their ownership and failures harder to assess.

## Decision

The Go built-binary E2E test
`TestAttachmentGrantRevocationAcceptance/attachment_upload_grant_revocation` owns
the admitted attachment mutation and direct grant removal race. It admits a real
1 MiB HTTP upload and keeps its body incomplete while Project member DELETE
completes with 204. A new access returns 404 before the body is released; the
already admitted upload then returns 201.
The test verifies the uploaded bytes and owned-resource cleanup against isolated
PostgreSQL and the real service. The Web combined authentication journey retains
its normal browser and installed CLI authentication, completed upload, membership
withdrawal and visible resource checks. It does not pause an upload or inspect
attachment database locks. Each native and container target requires ten combined
checks.

The [original combined acceptance decision](../../archived/testing/2026-10-23-authentication-combined-acceptance.md)
records why the installed client, real browser, transport and restart were tested
together under the original admission contract. The [attachment serialization
decision](../architecture/2026-11-06-attachment-task-deletion-serialization.md)
retained Task and authorization-source locks through mutation completion; under
that condition, a grant DELETE had to wait for the upload. The later [attachment
admission decision](../bug-fix/2026-11-06-attachment-admission-locks.md) keeps the
Task lock but reads authorization without holding source locks through file IO.
The current E2E therefore proves that grant removal completes while the admitted
upload is still open, rather than expecting a grant-lock waiter.

The [server guide](../../../../packages/daynight-server/README.md) and
[Web guide](../../../../packages/daynight-web/README.md#production-browser-acceptance)
own the current validation commands and inventories.

## Alternatives

**Keep the database observer in the Web journey.** It could observe the same
race alongside the browser, but would keep server transaction evidence coupled to
browser process, container and page timing. The Go built-binary fixture can prove
the HTTP and database ordering directly while the Web journey retains its own
visible behavior.

**Replace the historical lock wait with a mocked or timed delay.** A delay cannot
establish which transaction waits for the intended grant or that the upload holds
the lock. After the authorization-source locks were removed, the current test
instead observes successful removal and denied new access while the admitted
body remains incomplete.

## Consequences

Server ordering and browser/CLI behavior now have separate evidence and failure
ownership. The Web journey no longer claims the original paused-upload or socket
interruption proof. Both suites remain required for their respective outcomes;
a focused dirty overlay run cannot substitute for the clean combined CI result.
