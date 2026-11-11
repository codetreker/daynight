# Agent Note: Bot management reads and creation identity

Status: implemented

## Problem

A minimal assistant form must preserve the difference between automatic defaults
and explicit user choices. A lost creation response can leave a running Bot even
when the browser does not know the result. List navigation must neither duplicate
that creation nor confuse a selected Bot with a previously displayed Session.

## Decision

The [management page](../../../../docs/design/bot-management-web.md) consumes the
existing owner-scoped Bot API and uses the existing bounded Session cache. The
form records explicit overrides separately from displayed defaults and fences
Worker-specific responses. The server owns resolution and successful preferences.

A creation ID is retained before dispatch. Unknown outcomes expose only a GET
of that ID. A scope-owned memory record survives page unmounts; sessionStorage
holds only the ID for reload recovery. Confirmed outcomes clear the unresolved
record after admission; scope invalidation clears both records. Storage failures
retain the identity within the same document. Trusted receipts remain in scope
memory independently of presentation, so cancellation cannot turn confirmation
into an unknown result. The form owns cancellable publication and fences closing
or navigation by its draft revision and submission location. A result delayed
by identity pause remains available for an explicit open without an automatic
read or replay.

Visible pages poll independent list, defaults and detail resources every five
seconds. Complete pagination is published atomically so search covers the whole
list and partial failures do not remove previously observed assistants. Only the
selected authoritative detail can supply the Session binding. Startup readiness
and current Worker availability remain separate observations. The
[background-check decision](../bug-fix/2026-11-05-bot-background-check-display.md)
separates retained presentation from temporary request admission.

The routes reuse the Session shell's viewport height constraint. The Bot workspace
and conversation can shrink within it; the list and shared timeline own separate
scroll regions. Timeline pagination and retained reading positions therefore use
the actual visible conversation viewport.

## Alternatives

**Submit every displayed default.** This would turn automatic resolution into
explicit preferences and overwrite later defaults even when the user changed
only the name. The form instead tracks user changes separately.

**Keep unknown creation only in dialog or page state.** Both lose the ID on
navigation and permit a new creation after a committed but lost response. The
retained identity supports observation across remounts without replaying payloads.

**Hold the creation operation open until presentation is admitted.** A persistent
identity pause would retain its busy lock indefinitely and prevent local editing.
Settling locally preserves the actual receipt while admission still protects
presentation and follow-up reads.

**Search only the first page.** This silently hides matches in later pages. Full
pagination has a higher read cost but preserves a simple, complete search until
the API provides a server-side search contract.

**Let the document scroll the conversation.** An auto-height timeline expands
with its history, moves the composer off screen and appears perpetually too
short to the shared pagination hook. It also leaves timeline scroll bookmarks
unrelated to the document's reading position. A bounded Session viewport keeps
these existing contracts intact without adding a separate scrolling mechanism.

## Consequences

The route was delivered separately from hosting to avoid advertising an incomplete
assistant product. The [assistant composition](2026-11-05-assistant-composition.md)
connects navigation and hosting without replacing the page identity model.
Details and deletion controls can consume the same selection and cache. Polling
all pages costs more for large inventories and should be reconsidered with a
server search or change-feed contract. Unavailable browser storage cannot promise
reload recovery. Web fixtures prove request and presentation behavior, not native
Worker startup, persistence of successful preferences, or Provider execution.
