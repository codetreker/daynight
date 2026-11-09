# Agent Note: Invitation History State

Status: implemented

## Problem

An invitation fragment is a credential. The initial navigation owner serialized
its exact URL before the authentication child removed the fragment from the
address. Authentication preserved that state while scrubbing the address, so
canceling or leaving cleared temporary storage but left a recoverable credential
in browser-managed history. The admitted location also retained the old fragment.
The [navigation admission decision](../../archived/architecture/2026-11-04-draft-navigation-admission.md)
introduced exact URL matching to distinguish copied native fragment markers;
that distinction remains necessary.

## Decision

Navigation markers serialize only their existing segment and index. The
window-owned navigation instance keeps exact URL matches in memory, replaces the
entry on application replacement and fragment cleanup, and clears the table
when starting a new segment or disposing. URLs and invitation credentials never
become marker fields. The [navigation design](../../../../docs/design/daynight-task-steps.md#web-呈现导航与大集合)
owns the history algorithm and accepted unindexed-history limits.

Authentication captures an admitted project or Team invitation in a layout
effect before API effects, using the scope-specific invitation state and
temporary-storage policy. It
asks the navigation owner to clear the current fragment, updating the address,
in-memory URL and admitted location together. Indexed cleanup retains the index;
native cleanup removes a copied marker without numbering the entry or changing
foreign state. The clean snapshot and same-flow login return do not recapture a memory-only
invitation. Reopened links and scope changes replace the pending invitation;
authenticated views clear the temporary copy, login continuation restores the
matching scope, and a proven principal change retires the pending invitation.
The [authentication design](../../../../docs/design/daynight-auth.md) owns the
capture and terminal cleanup lifecycle.

## Alternatives

**Redact the fragment only in the serialized URL.** This leaves the admitted
location stale, and comparing only a redacted URL could turn copied native
fragment state into a valid indexed entry after cleanup.

**Capture before constructing navigation and hand the token to authentication.**
This needs another in-memory handoff and still requires handling later
application writes and native invitations. Keeping URL validation in navigation
avoids another credential owner while preserving existing authentication state.

## Consequences

Production-Application regressions cover startup, application writes, native
fragment arrivals, terminal cleanup and Back, including blocked temporary
storage. The in-memory URL table retains exact matching for draft guards without
persisting credentials; fragment cleanup replaces its old URL rather than
retaining the secret-bearing version. No new invitation store or reload recovery
mechanism exists. State from a previous navigation owner remains unindexed, as
before. The table consumes memory for the active history segment and lasts only
as long as that owner; unindexed and cross-segment traversal retain their
existing protection limits.
