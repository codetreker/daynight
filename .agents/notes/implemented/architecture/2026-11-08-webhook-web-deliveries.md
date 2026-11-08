# Agent Note: Webhook Browser Delivery Observations

Status: implemented

## Problem

Operators need to distinguish receiver acknowledgements, current failures,
unknown recovery and late observations for an original notification. Reading
history must not grant payload access, and registering a manual opportunity must
not manufacture a new event or confuse an earlier receipt with current state.
Delivery generations do not advance whenever resource access changes. Independent
list, detail and payload requests can therefore complete out of order and restore
private content after a newer restriction or retention deadline.

## Decision

The delivery panel extends the authenticated Webhook page and its existing
[fixed-intent controller](2026-11-08-webhook-web-management.md). It keeps explicit
owner, endpoint and optional Delivery navigation, scoped in-memory filters, and
GET-only history and recovery. Normal configuration GC retains an endpoint
tombstone while Delivery rows still reference it. The HTTP history contract also
supports a missing endpoint with retained Delivery rows: a valid history route
uses an explicit ID-only context after the configuration GET returns a validated
404. It invents no name, version or capabilities. Both contexts expose history
without current configuration or redelivery admission. A separate ID-only
checking-configuration context preserves authorized history while a withdrawn
configuration projection is being checked; it does not claim the endpoint is
missing or invent an Endpoint DTO. Native dialogs preserve
the workspace shell, language, focus and scroll behavior.

A shared observation registry binds every list and detail read to its start
observation. Each Delivery retains its latest generation and disclosure watermark.
Restrictive metadata, payload denial or expiry, URL-only destination redaction
and missing history advance that watermark across all readers. A full event can
still have a null target URL and a redacted display URL while retaining authorized
resource and payload access; that field restriction cannot restore an earlier
private destination. Full history with a null target URL also restricts the
owner management observation through the directory authority. Old endpoint,
signing-secret, manager caches and Admin labels are withdrawn. An independent
readable membership key preserves authorized Delivery and displayed payload
state: a continuous Team admin-to-member downgrade retains Team Project read
access. Older reads publish the current restricted view;
fresh authorized reads can restore a full view while retaining a watermark that
still rejects earlier reads. Page assembly, continuation failures and the current
operation projection use the same observation. Original receipts remain intact
when their private current projection is withdrawn. A validated 404 from the
selected Delivery, Attempt or payload GET withdraws its detail, displayed body,
redelivery confirmation and current operation projection, and fences pending
detail and list reads in that same scope. A configuration GET404 remains separate
from this history observation because retained history can still be authorized.
Payload denial concerns individual resource access. URL redaction additionally
restricts owner management authority without revoking its remaining read access.

Payload publication evaluates its known expiry against fresh time. Local payload
deadlines withdraw displayed bytes, and delayed responses cannot reinstall them.
Metadata retention depends on retained activity and attempts; the wire does not
provide its exact expiry, so the browser uses authoritative history reads rather
than deriving deletion from event age. Actual missing or restricted observations
withdraw the corresponding history. Selected pending or leased records check
every two seconds; terminal details and unselected lists check every 30 seconds
while the tab is visible and admission remains available. All checks use GET.
Background catalog verification pauses new
admission while preserving mounted dialog, draft,
payload and confirmation state. Confirmed identity, authorization, navigation and
expiry changes perform their corresponding cleanup.

Payload requests are explicit and independent. The browser verifies the requested
owner, endpoint, Delivery and observed event identity, media, canonical Base64,
byte count, the 65,536-byte limit, SHA-256 and valid UTF-8 before publishing text.
Web Crypto hashes the original decoded bytes. Text nodes display payloads and
resource labels without executable markup; current tasks and destinations do not
reconstruct history.

The redelivery descriptor fixes its original versions, generation and destination
revision along with the request identity and digest. The controller freezes the
validated owner, endpoint, Delivery, versions and revision as the admission
target. Kind-aware admission checks that same target before creating a nonce,
after identity readiness and before fetch. A per-original-target validator
prevents another currently selected eligible Delivery from authorizing a pending
intent for a different record. Only the expected 202 receipt
confirms registration. Its generation remains an immutable original result;
current history may have advanced further. A subsequent read failure cannot
reverse that confirmation. The server owns attempt creation, manual counts and
the original retry deadlines. Unknown and reloaded operations reconcile with GET,
without automatic POST or a replacement event.

The [Web design](../../../../docs/design/webhook-web.md) describes component and
publication responsibilities; the [Web requirements](../../../../docs/spec/webhook-web.md)
cover visible results, refusals and validation.

## Alternatives

**Fence list and detail independently.** Their request sequences cannot order a
newer disclosure restriction observed by the other reader, and generations remain
equal across access changes. A shared per-Delivery observation prevents this
cross-reader restoration while allowing a new authorized read to recover.

**Treat catalog verification as loss of authorization.** Background verification
has not established a permission change. Clearing visible payloads and dialogs at
that point discards valid interaction state; suspending admission preserves it
until the current identity and authority are confirmed.

**Bind the current Delivery generation to the receipt generation.** An older
valid receipt can describe an accepted registration while a later operation has
advanced history. Keeping original effects separate from current projections
avoids rejecting that receipt or misreporting the later state.

## Consequences

History, payload access and manual registration retain distinct permissions and
outcomes while sharing identity and operation recovery. The observation registry
adds scoped in-memory state and monotonic disclosure watermarks; it grants no
server access and does not make pages a frozen cross-request snapshot. Local
payload expiry and authoritative history withdrawal do not prove physical database GC.
Receiver 2xx and a redelivery 202 establish different facts, neither of which proves
external business completion. Private resource projections, bodies, credentials and signing secrets
remain outside operation persistence and URLs. Server retention and finite
receipt availability still limit how much history can be inspected or confirmed.
