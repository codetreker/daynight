# Agent Note: Combined Authentication Acceptance

Status: implemented

## Problem

Correct identity, membership and binary attachment components do not alone prove
that a production browser and an installed CLI share authority and data across a
service restart or access withdrawal. A real admitted upload, socket loss or
consumed provider result can also cross an authorization or transport boundary.
Acceptance must distinguish those observations from controlled-provider success,
historical source results and actual third-party human login.

## Decision

The [authentication requirements](../../../../docs/spec/daynight-auth.md) retain
AU-V1–AU-V10. The [activation decision](../architecture/2026-10-22-authentication-activation.md)
continues to own mandatory composition, normal-protocol credential bootstrap and
private fixture state. The [attachment acceptance decision](../../archived/testing/2026-10-21-task-attachment-cross-layer-acceptance.md)
records the shared installed-package identity, original-byte and paired-restore
proof choices retained here. The additional authentication harness composes those existing
mechanisms without adding product routes, privileged user adapters, provider
personas or a generic fixture-control service.

### One-time result loss on the real connection

`internal/server/auth_transport_acceptance_test.go` in the Go module uses the
pinned real UniAuth fixture and production Daynight composition. A narrow proxy
reads the gateway's successful `/auth/result` response, confirming that the real
one-time identity has been consumed, then closes the actual downstream TCP
socket before the SDK receives headers. The test requires upstream retrieval 410,
Daynight callback replay 401, zero pending/user/session rows for the failed
login, and one session after a fresh normal login. The proxy records actual
request/consumption/close counts; safe network classification and secret checks
remain independent of the failure's HTTP redirect.

Cleanup closes the product, proxy transports and real gateway and requires zero
active requests and hijacked connections. A fake SDK response or a reader that
fails after returning headers cannot establish this transport observation.

### Browser and installed-CLI authentication on each target

`packages/daynight-web/scripts/acceptance/auth-combined.mts` owns the normal
browser and installed-CLI journey, safe API operations, exact int64 versions,
receipt and strict result validation. `auth-combined-target.mts` validates the
run, source and PostgreSQL ownership before expiring a PAT minted by the normal
browser session. It does not inspect attachment staging files, metadata or
database lock waiters, and does not insert credentials, users or members.
`auth-combined.test.mts` exercises ownership guards, normal-PAT-only expiry,
receipt validation and browser lifecycle without claiming a production journey.

The combined entry accepts explicit installed-package receipt and target restart
callbacks. The runner owns service lifecycle, database, files, gateway and image
identity. Restart replaces only the Daynight service, preserving its origin,
database, file root and UniAuth state. It records before/after process identity
and readiness. The shared installed-package validator still checks the parent
receipt's source, entry and tarball hashes; an explicit receipt parameter does
not permit an unverified installation.

Each target uses the existing normal-protocol Alice/Bob personas, recording their
initial project sets A0/B0 before creating shared P and Bob-private Q. Project
pagination uses limit1 and compares complete sets against those baselines, so
existing scenarios' projects do not become accidental empty-database assumptions.
A normal invitation joins Bob as member. Member task/file writes and denied
administrator operations retain the existing two-role semantics. The completed
`same-data-cli-browser` journey verifies the task and original binary bytes
through the production browser and installed CLI.

Original Cookie, PAT, membership, invitation and file state must survive the
service-only restart. Logout invalidates its session while PAT authority stays;
PAT revocation denies the real CLI. Normal membership DELETE then removes Bob's
direct grant. New CLI, raw API, preview GET/HEAD and browser reads deny access to
P while Q remains readable. A normally minted PAT is expired and rejected by the
installed CLI with 401. The bilingual token UI holds a real creation response
while switching languages, then verifies the same pending input, single
submission and revealed token element across English/Simplified Chinese.
Screenshots follow secret closure or masking.

The [Web validation guide](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns the current functional inventory. Both targets require a separate combined
receipt. The [local stress decision](2026-11-03-local-stress-suites.md) moves the
five native capacity/limit scenarios behind explicit local stress acceptance
while preserving fixed data, five samples, geometry checks and timing budgets.
Both modes retain exact raw report validation, zero retries and complete cleanup.
Local capacity remains isolated from competing preparation, restart and container
cleanup.

### Server ownership of the grant-lock race

`packages/daynight-server/cmd/e2e_tests/attachment_grant_lock_acceptance_test.go`
owns `TestAttachmentGrantLockAcceptance/attachment_upload_grant_lock`. It uses
the existing built-binary fixture, real authenticated HTTP upload and Project
member DELETE, and isolated PostgreSQL. It admits a 1 MiB upload, observes the concurrent
DELETE waiting on the exact grant row held by the attachment transaction, then
completes the body. The upload returns 201, member removal returns 204, subsequent
cookie and PAT access return 404, uploaded bytes match and owned resources are
cleaned up.

The original combined browser journey proved that membership removal completed
while an admitted request still held an incomplete body, after which that upload
could return 201. This matched the then-current authorization snapshot, which
ended before file I/O. It also separately tested a real interrupted upload and
staging cleanup. The later [attachment serialization decision](https://github.com/codetreker/daynight/blob/7ee7d369dbc6a3c11c606fe9e6ebcd4e01f93908/.agents/notes/implemented/architecture/2026-11-06-attachment-task-deletion-serialization.md)
retains authorization locks through mutation completion, so removal now waits for
the admitted upload rather than committing during its body. The built-binary Go
E2E test owns that changed ordering. Browser acceptance retains independent
authority, rendering, restart and shared-data checks on both targets, but no
longer runs paused upload IO or the separate socket-disconnection scenario. The
current split does not claim that socket-disconnection scenario as migrated.

### Safe evidence and failure ownership

The schema 1 `kind: auth-combined` receipt is written atomically under each run
as `native/auth-combined/target.json` or `container/auth-combined/target.json`.
It journals running/passed/failed result, pending/passed/failed cleanup and browser
cleanup independently. It binds target/source, validated installed-package hashes,
browser identity, individual observations and old/new restart PID/start identity;
the parent evidence retains the source dirty flag. Strict validation requires
all ten named checks exactly once and passed cleanup, not merely a successful
process exit: `partial-sharing`, `normal-member-writes`, `bilingual-token`,
`same-data-cli-browser`, `restart-original-state`, `logout-independent-pat`,
`pat-revocation`, `membership-revocation`, `expired-pat` and `secret-scan`. Observations retain safe status/request-ID/UUID/version/hash
metadata; credentials, configuration/request bodies and raw logs are excluded.
Log scanning happens privately and publishes only its safe verdict. Private homes,
Cookie/PAT/App state and fixture environment remain outside uploaded receipt
roots. Request failures retain only safe operation/method/path/category/status
metadata; secrets and raw transport causes do not become assertion values.
Playwright action/network traces remain off while PNG and custom CDP evidence
retain their existing owners.

Every browser/context, CLI group and callback command has an owner and bounded
completion. Cleanup failure fails the run and preserves the
initial failure alongside safe cleanup diagnostics. Recovery validates recorded
source/process/image ownership before removing resources and includes both
combined directories in the existing browser/process scan. It cannot guess a
live process's ownership from a PID alone.

## Alternatives

**Use independent component successes as combined proof.** At adoption, the
existing suites established PG competition, same-email identity, resource
isolation and basic installed binary bytes, but did not prove original
credentials and shared data across the same target's restart or membership
change during a real upload. The combined journey supplied those observations.
The current browser journey retains restart and browser/CLI withdrawal checks;
the server journey separately owns the admitted-upload grant-lock race. The old
interrupted-upload observation remains historical evidence for its source.

**Keep paused-upload probes in browser acceptance.** This couples the browser
runner to server transaction details, database query shape and a dedicated
transport. The built-binary Go E2E test retains the actual HTTP and PostgreSQL
grant-lock observation. The separate socket-disconnection case is not retained
by this split.

**Substitute an SDK mock or failing response reader for the wire loss.** Such a
test can establish error handling without proving the real gateway consumed its
one-time result before the downstream response vanished. The narrow proxy
keeps real gateway state and the actual SDK connection in the observation.

## Consequences

The merged activation baseline is commit
`d07d5ec82aa5e5240d247651b5dc0bfe0e9eda7e`, tree
`352fd5f48058517b07e863774b2dbbc2e977dc8b`. Its
[CI run](https://github.com/codetreker/daynight/actions/runs/39820726467) and merge
receipt establish equality with the tested PR/synthetic-merge tree. Existing
real-SDK/PG competition, same-email, binary, deployment and 51-case results stay
valid for that source; they are not missing work or evidence for modified code.

The added Go wire-loss test has a focused race pass for file SHA256
`20d5e75452021f75e879c850de8b8f9bcf1e4efe984afd7e85f4ee107555c6b7` on that baseline.
The working tree then contained the uncommitted test, so this is a dirty-source
focused result, not a clean-head or complete acceptance claim. Full current-code
CI, both combined run receipts and their cleanup must be assessed separately.

Actual App/third-party human login and configured isolated deployment remain
independent acceptance items. Controlled external-provider responses, provider
discovery, readyz or successful deployment do not fulfill human login. Required
callback registration, access or human interaction may remain pending; the task
cannot be marked fully complete until its real-upstream evidence and required
platform-confirmed PR merge are present. Existing service, proxy, DNS or App
settings are not changed by the test harness.
