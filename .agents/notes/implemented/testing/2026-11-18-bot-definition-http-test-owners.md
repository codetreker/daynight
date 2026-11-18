# Agent Note: Bot Definition HTTP Test Owners

Status: implemented

## Problem

The Bot definition HTTP tests created a PostgreSQL schema, prepared a UniAuth
login and minted a PAT to exercise route parsing, response projection and
authentication. The same fixture prepared Workers and Bot records for paging
and deletion. That setup repeated database and gateway work for cases whose
decisions belong to the HTTP routes, while also providing a lower-layer check
that an owner's list cursor is rejected on a Worker-scoped list.

## Decision

The three Bot definition tests register the production Bot routes, request
logging and PAT middleware. Controlled credential results exercise valid,
anonymous and revoked requests. A pending operation checks the exact request
context, principal, identifier, parsed page or deletion arguments, and call
count. Invalid HTTP input, unsupported methods and authentication refusals
leave the Bot operations unused. The lower refusals for malformed Worker and
deletion IDs and the cross-scope cursor arrive through their actual route
dispatch. [Bot expiry HTTP decision](2026-11-10-bot-expiry-http-test-owners.md)

Each operation receives an independent page, Bot, receipt or error. The HTTP
test retains the non-null empty page, both continuation requests, canonical
detail ID, exact decimal version above the JavaScript safe integer range, UTC
timestamps and private response headers. Deleted Bot facts still contain
private definition fields, so deletion replies, detail and Worker inventory
exercise the real redaction. The test also checks that request logging omits
private Bot content.

`TestListCursorPreservesWorkerScope` exercises Core cursor validation for the
same owner across the global and Worker lists. The service test
`TestBotListContinuesWithinItsScope` consumes cursors issued by the service,
checks the exact continuation keyset sent to storage, and rejects a global
cursor on the Worker list before opening a snapshot. Bot deletion Core and
service tests own input validation, intent replay and conflicts. The PostgreSQL
`TestBotStorageDeletionAndScopedPagination` and integrated Bot deletion tests
retain persisted visibility, version and cleanup proofs.

## Alternatives

**Keep the database and gateway setup in all three HTTP cases.** This exercises
the complete application through authentication, at the cost of repeating its
infrastructure for parser refusals and deterministic wire projections. Other
integrated cases retain that assembly.

**Build an in-memory definition store for the route tests.** Deriving later
reads from captured deletes would duplicate Bot behavior and make wire
expectations depend on the mutation observed by the same test. Independent
facts keep the response checks explicit. The real Store contract verifies the
state transitions.

## Consequences

The route tests run without PostgreSQL or UniAuth fixture variables.
Cursor scope, persisted list visibility and cleanup obligations remain covered
at their owning layers. The fixture still requires explicit expectations for
each new operation or authentication outcome used by these HTTP cases.
