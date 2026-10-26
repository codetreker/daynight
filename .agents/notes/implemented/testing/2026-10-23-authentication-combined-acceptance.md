# Agent Note: Combined Authentication Acceptance

Status: implemented

## Problem

A correct identity module, membership transaction and binary attachment journey
do not alone prove that a production browser and an installed CLI retain the
same authority and data across a service restart, revocation during an admitted
upload, or actual socket loss. A provider result can also be consumed upstream
while its response never reaches Daynight. Acceptance must distinguish those
observations from controlled-provider success, historical source results and
actual third-party human login.

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

### One additional journey for each target

`packages/daynight-web/scripts/acceptance/auth-combined.mts` owns the normal
browser and installed-CLI journey, safe API operations, exact int64 versions,
receipt and strict result validation. `auth-combined-target.mts` validates the
run's source, PostgreSQL container labels and native storage or container image
before reading actual staging files and metadata. Its only database mutation is
expiring a PAT that the normal browser session has already minted; it does not
insert credentials, users or members. `auth-combined-transport.mts` owns a real
bounded PUT socket with explicit prefix, completion, disconnect and close
operations. Its write callbacks describe bytes sent; independent filesystem and
SQL observations establish admission. `auth-combined.test.mts` exercises target
ownership, exact observations, normal-PAT-only expiry and actual socket
completion/disconnection/error cleanup without claiming a production journey.

The combined entry accepts explicit installed-package receipt and target restart
callbacks. The runner owns service lifecycle, database, files, gateway and image
identity. Restart replaces only the Daynight service, preserving its origin,
database, file root and UniAuth state. It records before/after process identity
and readiness. The shared installed-package validator still checks the parent
receipt's source, entry and tarball hashes; an explicit receipt parameter does
not permit an unverified installation.

Each target uses the existing normal-protocol Alice/Bob personas, recording their
initial project sets A0/B0 before creating shared P and Bob-private Q. Project
pagination uses limit1 and compares the complete sets against those baselines,
so existing scenarios' projects do not become accidental empty-database
assumptions. A normal invitation joins Bob as member. Member task/file writes
and denied administrator operations retain the existing two-role semantics.
Browser and installed CLI then observe the same task and original binary bytes.

Original Cookie, PAT, membership, invitation and file state must survive the
service-only restart. Logout invalidates its session while PAT authority stays;
PAT revocation denies the real CLI. A real PUT pauses after 64 KiB is observed in
staging with no final file or attachment-index row. Removal then changes current
membership while the request body remains open. Completing the suffix can return
201 under the existing admission rule, while new CLI/raw P requests fail 404 and
Q remains 200. Another real socket is disconnected while uploading and its staging
and index must disappear. A normally minted PAT is then expired and rejected by
the installed CLI with 401. These tests preserve K1 and do not add post-IO
membership rechecks or serialize credential revocation with business commits.

The production token UI holds a real creation response while switching languages,
then verifies the same pending input, single submission and same revealed token
element across English/Simplified Chinese. The response remains the actual
server result. Screenshots happen only after closing or masking the secret.

The current 53 Playwright cases comprise 24 native functional, 24 container
functional and 5 native capacity, including the later task-unapproval scenario. Native and container each require a separate
combined receipt. These receipts do not renumber the Playwright inventory or
replace its fixed data, five samples, geometry checks, zero retries, raw report
validation or time/request/memory budgets. Capacity remains isolated from
competing preparation, restart and container cleanup.

### Safe evidence and failure ownership

The schema 1 `kind: auth-combined` receipt is written atomically under each run
as `native/auth-combined/target.json` or `container/auth-combined/target.json`.
It journals running/passed/failed result, pending/passed/failed cleanup and browser
cleanup independently. It binds target/source, validated installed-package hashes,
browser identity, individual observations and old/new restart PID/start identity;
the parent evidence retains the source dirty flag. Strict validation requires
all eleven named checks exactly once and passed cleanup, not merely a successful
process exit: `partial-sharing`, `normal-member-writes`, `bilingual-token`,
`same-data-cli-browser`, `restart-original-state`, `logout-independent-pat`,
`pat-revocation`, `socket-disconnect`, `admitted-member-removal`, `expired-pat`
and `secret-scan`. Observations retain safe status/request-ID/UUID/version/hash
metadata; credentials, configuration/request bodies and raw logs are excluded.
Log scanning happens privately and publishes only its safe verdict. Private homes,
Cookie/PAT/App state and fixture environment remain outside uploaded receipt
roots. Request failures retain only safe operation/method/path/category/status
metadata; secrets and raw transport causes do not become assertion values.
Playwright action/network traces remain off while PNG and custom CDP evidence
retain their existing owners.

Every open request/socket, browser/context, CLI group and callback command has an
owner and bounded completion. Cleanup failure fails the run and preserves the
initial failure alongside safe cleanup diagnostics. Recovery validates recorded
source/process/image ownership before removing resources and includes both
combined directories in the existing browser/process scan. It cannot guess a
live process's ownership from a PID alone.

## Alternatives

**Use independent component successes as combined proof.** The existing suites
already establish PG competition, same-email identity, resource isolation and
basic installed binary bytes. They do not demonstrate original credentials and
shared data surviving the same target's restart or membership change during a
real body upload. The new journey adds those observations while preserving the
existing proof's exact-source scope.

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
