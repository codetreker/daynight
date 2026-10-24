# Agent Note: Silent Foreground Identity Checks

Status: implemented

## Problem

Returning to a browser tab hides the entire authenticated workspace and opens a
full-screen identity-check dialog, even when the account has not changed. This
looks like a page reload and interrupts focus in open forms, task details and
attachment previews. Identity checks must still detect account replacement and
session loss, and failed checks must remain visible and recoverable.

## Decision

Foreground identity checks run in the background while the current authenticated
workspace stays visible and interactive. They do not open a dialog, hide content,
change inertness or move focus. Same-user success keeps the session generation
and component instances, including drafts and one-time secrets. Each qualified
external return synchronously cancels and supersedes the previous check;
responses from older checks cannot decide the current identity. A confirmed
account change invalidates owned requests and remounts the identity domain; a
current 401 clears it.

The authentication shell pauses the shared API request boundary on top-level
departure, before any returning child's visibility listener can dispatch a
resource read. Its layout effect also pauses an already-away authenticated mount
before child passive request effects. Paired hidden/blur events coalesce; leaving
during a pending check aborts and supersedes it immediately. Returning visible
and focused starts the latest identity check, independent of which return event
arrives first. New resource reads and writes wait until identity is verified. Each waiting request retains its original auth
generation and supports cancellation. Same-user success resumes requests; an
identity change or session clear invalidates the generation before releasing the
wait, cancelling old-identity requests before fetch. Identity checks and logout
bypass the wait. Independently verified project not_found notifications also
withdraw matching cached access immediately; they grant no content and their
persistent cleanup still waits for the identity gate. Superseded checks cannot
release it; failed checks keep it
pending through recovery. This keeps a visible account label from authorizing
an action with another account's shared Cookie.

A failed identity check preserves component state behind the existing blocking
error overlay. Explicit retry and subsequent external returns retain that block
until verification succeeds. Initial identity loading continues to use its
loading page. Graph polling and resource authorization keep their existing
owners and behavior.

This partially replaces the concealment policy of the
[authenticated workspace decision](../feature/2026-10-22-web-auth-workspace.md).
The [authentication requirements](../../../../docs/spec/daynight-auth.md#web-交互与状态)
and [design](../../../../docs/design/daynight-auth.md) own the complete current
contracts.

## Alternatives

**Conceal the workspace on every foreground check.** The original policy hid a
previous account immediately during a cross-tab identity change. It also obscured
unchanged accounts on every tab return and moved focus into a full-screen dialog,
which interrupted normal browsing.

**Remove foreground identity checks.** This would avoid their visual effect but
leave an idle tab unaware of account replacement until another resource request.
Keeping checks and separating their presentation preserves timely detection.

## Consequences

Ordinary tab returns retain visible content, dialogs, focus and browsing state.
The account check alone leaves loaded content visible and interactive while
pending, including when another tab has changed the shared session. A separately
verified project access loss immediately withdraws its content, including during
that pause; identity checking does not defer negative access decisions. New
resource requests wait for identity confirmation before dispatch and still
authenticate and authorize on the server. This explicitly accepts a display
interval until the check confirms the change; it does not
promise immediate cross-tab concealment. Verification errors block recovery
without destroying retained state. Real browser tab-return coverage and deferred
request tests protect continuity and stale-response suppression together.
