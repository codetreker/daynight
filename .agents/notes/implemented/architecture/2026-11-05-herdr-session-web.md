# Agent Note: Herdr Session Views and Fixed Recording Readers

Status: implemented

## Problem

Task Session originally exposed only native Web timelines. Terminal executions
need visible-only observation and explicit control ownership, while historical
records must remain readable after a replacement claim without gaining input
capabilities. Ordinary mutable attachments cannot carry that immutable identity.

## Decision

The task host dispatches current executions to the existing Web adapter or a
terminal client. Terminal observation follows actual view and document visibility;
closing its viewer channel releases its browser lease without stopping Worker
recording. Historical selection and a separate managed attachment section open
fixed Session references through read-only archive loaders.

Managed entries occupy a separate section of the attachment sidebar and share
the existing preview column. An additional vertical recording region would
starve ordinary readers in short viewports. Switching to a recording hides and
disables the retained file preview without discarding upload drafts or iframe
state; selecting a file restores the ordinary reader.

Operation submission and receipt polling share one deadline. Explicit reads of
an already unknown operation have a separate bounded window without replaying
input. A missing receipt is ambiguous because admission can fail before the
operation row exists; the client verifies access to the original Session before
treating a receipt 404 as access loss. Query results remain fenced to their
operation and viewer binding.

The terminal renderer uses text nodes and validated styles for both live and
recorded frames. Playback orders complete frames and explicit gap nodes using
integer segment-relative times. It stops at gaps rather than extending the last
screen across missing observations.

Unknown initial disposition is a separate durable control action from automation
resumption. The protocol advertises the supported action, preserves the original
unknown outcome and records the human decision while remaining suspended.
The [input arbitration design](../../../../docs/design/herdr-input-arbitration.md)
owns that state transition. The [Web design](../../../../docs/design/herdr-session-web.md)
owns page and archive loading mechanisms.

## Alternatives

**Place terminal content in the native timeline.** This would reuse chat layout
but manufacture message and turn semantics that terminal snapshots do not have.
Separate backend views preserve native meaning and leave the existing Web client
connection behavior unchanged.

**Treat recordings as ordinary attachments.** This would reuse the file tree but
expose mutable-file actions and lose the original execution fence. A managed
section shares discovery and rendering while withholding attachment mutations.

**Treat a missing receipt as Session loss.** The relay maps both an absent
operation row and an inaccessible Session to 404. Closing the viewer on that
status alone removes recovery from valid Sessions; an independent original
Session read preserves recovery without relaxing actual access denial.

**Combine unknown disposition with resume.** The original control request could
record disposition only while entering automation. That cannot represent a user
who has resolved delivery but has not authorized subsequent automatic input.
Separate actions preserve both decisions and reject ambiguous combined requests.

## Consequences

The terminal client adds a separate lease and operation lifecycle, which requires
explicit visibility, late-response and permission tests. Playback receives no
control client. v2 validates original bytes against the fixed archive hash;
v1 retains its existing server hash validation because its JSON envelope does
not preserve original byte encoding.

Mouse, arbitrary resize, takeover, raw terminal streams, independent export,
remote continuous backup and automatic source collection remain outside this
interface. Adding them would require reconsidering terminal ownership and archive
format guarantees, not merely adding controls.
