# Agent Note: Task Detail Order and Empty Session Records

Status: implemented

## Problem

Task readers need attachment content before Steps, while a Session records
section with no history consumes sidebar space without offering a useful entry.
A history request can also be loading, fail, or contain records whose archives
are not ready; none of those states establishes that history is empty.

## Decision

The shared detail panels order Overview, Attachments, Steps, optional Discussion,
and optional Session. The same ordered collection drives panels and keyboard
navigation. Steps retains its URL and mounted draft behavior, and attachment
controllers retain their selection and preview state. The
[Steps reading decision](2026-11-04-task-steps-web-reading.md) owns the shared
reader and its resource lifecycle.

The managed records section is omitted only after the current history request
succeeds with no accumulated records and no next cursor, with no loading or
error. Unknown, loading, failed and incomplete results remain visible; every
historical record remains an entry regardless of archive readiness. Once an
empty inventory removes its refresh control, reactivating the owning tab reads
it again so new records can be discovered. A nonempty inventory remains cached
across tab changes and keeps its explicit refresh control. The
[Herdr Session decision](2026-11-05-herdr-session-web.md) owns fixed identity,
read-only replay and shared attachment preview behavior.

## Alternatives

**Hide when no archive is ready.** Pending, failed or unavailable recordings
would disappear even though their original executions exist and can provide a
visible status or later become readable.

**Keep the empty section.** This preserves a refresh control even after an empty
result, but reserves space for an entry that offers no record to read. A new
request is made when the owning tab is reactivated, the view is reloaded or
its owner is recreated.

**Treat missing results as empty.** A first load, incomplete page or failed read
would hide the loading or recovery path and wrongly report an unknown history
as absent. Successful exhaustion is required to establish emptiness.

## Consequences

The order is consistent in dialog, standalone and fullscreen views and remains
navigable by keyboard. A confirmed empty history removes the section and its
refresh control; the next tab activation incurs a history read and can reveal
new records. History is not polled continuously while the tab remains active.
This does not change recording, ordinary attachments or Session execution.
Visible loading and error states preserve recovery when absence has not been
established.
