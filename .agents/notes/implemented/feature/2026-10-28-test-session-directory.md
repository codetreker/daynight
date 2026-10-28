# Agent Note: Owner-Scoped Test Session Directory

Status: implemented

## Problem

Standalone Controller sessions print individual URLs, but users cannot easily
return to a session after closing its page or losing terminal output. Native
session identifiers are too long to serve as a practical navigation mechanism.

## Decision

The authenticated `/test-sessions` page lists the current user's accessible
online Daynight Test Sessions. Its paginated API applies
the same owner and parent-credential admission rules as a direct Test read.
Task sessions and other users' records are excluded before pagination.

Rows show provider, lifecycle and connection status, creation time and latest
persisted activity time. Stable identity remains the full session ID in the link;
the visible short identifier is only a reading aid. Refresh starts a new traversal,
and the browser deduplicates pages by session ID when activity changes ordering.
The initial directory included archived and disconnected sessions to make saved
URLs discoverable. The [online-directory decision](2026-10-28-online-test-session-directory.md)
changes the default page to focus on live debugging while retaining direct history access.

The page and API namespaces are reserved from OAuth callback configuration so
route registration cannot collide with an otherwise valid login callback.

The [Controller requirements](../../../../docs/spec/controller-test-sessions.md)
own directory behavior. This extends the
[standalone ownership decision](../architecture/2026-10-28-controller-test-session-ownership.md)
without broadening native execution authority.

## Alternatives

**Retain URLs in terminal output alone.** This avoids a new read endpoint but
does not let users discover their registered sessions after losing that output.

**Build a general native-session browser.** Scanning machines or importing
provider histories introduces discovery, identity adoption and recovery concerns.
The registered Test Session directory solves navigation using existing identities.

## Consequences

Directory metadata is protected on the server, not merely hidden in the UI.
Credential revocation can remove a row from a later read without deleting its
stored history. A list page is an observation, not a durable authorization grant;
following a link rechecks access.

Sorting by recent activity can move records between page requests. Explicit
refresh recovers moved records, and identity-based merging avoids duplicate rows.
The directory offers navigation only. Remote creation, deletion and recovery
remain separate features that can be added without changing session identity,
provided each retains its own authorization and process-ownership rules.
