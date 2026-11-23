# Agent Note: Display sent images and settle their draft release

Status: implemented

## Problem

After a message with images was accepted, the sending window showed the new
images as unavailable until the page was reloaded. The composer also showed an
image operation error and repeatedly sent `DELETE image-uploads/{uploadId}`,
each answered with 409 `resource_in_use`.

Two independent gaps produced this. Live `timeline_upsert` events carry image
parts but no `SessionResource` descriptors, and no Controller publishes
`resource` events for them; only history pages carry descriptors. Separately,
accepting a submission records a release intent for each frozen draft upload.
The service correctly refuses to release an upload that the sent message now
references, but the draft uploader treated the refusal as an unknown outcome,
surfaced it as an error, and kept observing and retrying it.

## Decision

The [browser image design](../../../../docs/design/session-image-browser.md)
defines both behaviors.

- When a live entry references a resource missing from the current state, the
  Session client reads the current tail history page at most once per entry
  revision and adds only the missing descriptors. It does not reconnect or
  replace accepted rows, coverage, or connection state. A failed read leaves
  the image unavailable until the next history load.
- A 409 `resource_in_use` answer to a draft release is a definitive outcome.
  The draft store records `releaseRetained` on the upload, clears the pending
  action, and the uploader neither retries nor reports an error. Other errors
  keep the existing unknown-outcome handling.

## Alternatives

**Publish `resource` events from the Controller.** The protocol already accepts
them end to end. It would fix new Controllers only, while deployed Workers keep
their current CLI, and it adds descriptor traffic to the bounded outbox. The
Web read works with every Controller version and can coexist with a later
Controller change.

**Seed descriptors from the accepted draft's upload receipts.** This fixes only
the sending window; other windows and later revisions still lack descriptors.

**Reconnect through the existing refresh.** It obtains descriptors but drops
the live connection and restarts hydration for every sent image message.

**Stop releasing uploads after an accepted send.** The draft cannot always tell
which uploads the service has already pinned, and an explicit release is still
required for removed or replaced images.

## Consequences

Each live entry revision with unknown resources can cost one tail history read.
A descriptor for an entry older than the tail page is not recovered until a
later history load. A retained release leaves the service's upload reference in
place; the service reclaims it under its upload expiry and reference rules. The
same answer for an image removed while a send was unknown also ends the draft's
release attempt, so that upload reference is likewise left to service expiry.
Rows stored before `releaseRetained` existed omit the field; their next release
attempt records the service's answer.
