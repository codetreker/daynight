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
holds only the ID for reload recovery. Confirmed outcomes and scope invalidation
clear the record. Storage failures retain the identity within the same document.

Visible pages poll independent list, defaults and detail resources every five
seconds. Complete pagination is published atomically so search covers the whole
list and partial failures do not remove previously observed assistants. Only the
selected authoritative detail can supply the Session binding. Startup readiness
and current Worker availability remain separate observations.

## Alternatives

**Submit every displayed default.** This would turn automatic resolution into
explicit preferences and overwrite later defaults even when the user changed
only the name. The form instead tracks user changes separately.

**Keep unknown creation only in dialog or page state.** Both lose the ID on
navigation and permit a new creation after a committed but lost response. The
retained identity supports observation across remounts without replaying payloads.

**Search only the first page.** This silently hides matches in later pages. Full
pagination has a higher read cost but preserves a simple, complete search until
the API provides a server-side search contract.

## Consequences

The route can be integrated without advertising an incomplete assistant product.
Details and deletion controls can consume the same selection and cache. Polling
all pages costs more for large inventories and should be reconsidered with a
server search or change-feed contract. Unavailable browser storage cannot promise
reload recovery. Web fixtures prove request and presentation behavior, not native
Worker startup, persistence of successful preferences, or Provider execution.
