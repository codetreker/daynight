# Agent Note: Webhook query owners

Status: implemented

## Problem

Webhook page tests repeatedly match named controls against every control of the
same role in the document. Endpoint, owner and editor actions have distinct
rendered owners, so these searches calculate accessible names for unrelated
controls. That work recurs across permission, reconciliation and draft cases.

## Decision

The page tests resolve the current Owner group, endpoint complementary region or
native dialog before querying their controls by the original role and accessible
name. Each helper reacquires its owner through a unique visible role query and
returns Testing Library's bound queries. Controls retain role, name and default
visibility matching within that owner.

Owner and endpoint changes, recovery, Back navigation and locale changes can
replace nodes. Queries therefore use the current rendered owner on every lookup;
the helpers do not cache owner elements across asynchronous transitions.
Intentional identity and focus assertions keep their original node references.

Document-wide private URL and secret checks, absent dialogs and errors, current
dialog identity, endpoint counts and multiple New webhook controls retain their
global queries. Hidden-control checks retain their explicit visibility options.
The [observation decision](2026-11-08-webhook-observation-boundaries.md) still owns
the native digest, request dispatch, response admission and React effect barriers.
Those barriers, fixture data, assertions and deadlines remain intact.

The [Web validation guide](../../../../packages/daynight-web/README.md#development)
owns validation commands and the strict coverage gate.

## Alternatives

**Repeat document-wide named control queries.** Unrelated buttons and fields
participate in each lookup even when the action belongs to a known endpoint or
editor. Global scope remains appropriate for absence, privacy and whole-page
cardinality proofs.

**Cache controls across page transitions.** A detached editor or an older
endpoint's action can survive as a JavaScript reference after the current view
changes. Fresh owner lookup keeps interactions and state checks tied to the
rendered view.

**Replace semantic queries with CSS selectors.** That would remove the role,
accessible-name and visibility checks exercised by these controls. CSS traversal
does not substitute for those interaction semantics.

## Consequences

Control name matching visits the relevant rendered owner. A small owner lookup
is retained rather than sharing mutable DOM references between phases or tests.
The tests still exercise the real page, native hashing and asynchronous state
publication; their product inputs and output assertions are unchanged.

The cost of DOM queries depends on the environment and test workload. A faster
file or command does not by itself establish a faster hosted job or workflow.
