# Agent Note: Resolve Step panel controls within their owners

Status: implemented

## Problem

Step panel regressions render complete pages of up to 100 visible rows from a
241-Step collection. Repeated document-wide role queries calculate accessible
names and visibility for unrelated row controls. Their cost can dominate the
interaction under test even though the required pagination, draft and focus
boundaries depend on retaining those rows.

## Decision

The panel tests resolve controls within their actual Step row, toolbar,
pagination, draft form or confirmation dialog. Queries retain the original
accessible roles and names, ordinary visibility filtering and interaction order.
Existing Step IDs identify row owners; structural selectors identify the same
form and toolbar owners already used by the fixtures. Owner helpers resolve the
current DOM after changes rather than retaining replaced elements.

The full collection sizes, 100-row page boundaries, input values, error paths,
write arguments, confirmation decisions and focus assertions remain exercised.
Production components, timing, test discovery and V8 coverage settings are
unchanged. The [Web validation guide](../../../../packages/daynight-web/README.md#validation-and-build)
owns commands and the complete coverage gate.

## Alternatives

**Reduce the pagination fixture.** Smaller lists would avoid query work, but
would stop crossing the existing page and off-page-draft boundaries. The test
needs real page-sized DOM to qualify the interaction.

**Replace role queries with control selectors or hidden-element queries.**
Selecting controls directly could avoid accessible-name and visibility work but
would lose those checks. Only the owner is selected structurally; the control is
still found through its visible role and accessible name.

**Keep global queries and enlarge deadlines.** A larger allowance would leave
the repeated accessibility traversal in every run. Querying the operation's
owner removes unrelated work without changing the execution budget.

**Optimize independent Go waits or Windows lifecycle mechanisms together.**
The Go overlap tests and native Job/hook regressions have separate timing and
ownership proofs. They can be optimized independently while this change retains
their current behavior and validation. Their deferred cost does not require a
shared test scheduler or a production abstraction in the panel tests.

## Consequences

The suite spends less time computing names and visibility for unrelated controls.
Owner selectors depend on existing Step identity and structural containers;
changing that structure requires updating the fixture helpers. A missing owner
or an inaccessible control still fails the test.

Scoped queries do not establish that no unrelated duplicate control exists
elsewhere in the document. Assertions that count or inspect the complete page
retain their global scope. Mutation checks for draft protection and deletion
focus must fail in both the original and optimized tests.

File and focused-command savings are separate from whole-job or pipeline
improvements. Browser acceptance and other platform-native tests may remain the
CI critical path.
