# Agent Note: Web Test Environments

Status: implemented

## Problem

Ordinary Web tests include graph algorithms, wire parsing, HTTP wrappers and
state transformations as well as browser components and persistent caches.
Preparing jsdom, React cleanup, navigation and tracked IndexedDB operations for
every file makes browser-independent checks pay for resources they do not use.
The quality command needs complete coverage and file isolation with a bounded
worker budget.

## Decision

The ordinary Vitest configuration contains two disjoint projects. An explicit
file inventory selects the `node` project after dependency review. The `ui`
project owns the complementary ordinary test glob, including newly added files.
Node setup restores mocks, stubbed globals and real timers after each case.
UI setup retains its existing React cleanup, DOM shims, fresh IndexedDB factory,
tracked transaction drain, history, storage and navigation cleanup.

The selection follows executed dependencies. HTTP tests can use Node's native
Fetch objects when they do not exercise browser channels or invitation origins.
Pure geometry and state transformations do not require a document. Tests using
DOM parsing, real IndexedDB, browser storage, navigation, focus or Session
channel builders retain jsdom. Importing a module with a browser-dependent
function does not require that function's environment when the test exercises a
separate pure or injected path.

Both projects use isolated `forks` and share the command's total worker budget,
including the existing four-worker CI setting. They contribute to one V8 report
with the complete product-source inventory and strict statement gate. Ordinary
test discovery, cases, assertions and failure deadlines remain unchanged. The
[worker capacity decision](2026-10-28-web-quality-worker-capacity.md) owns the
resource calibration; the [Web validation guide](../../../../packages/daynight-web/README.md)
owns commands and the complete coverage gate.

## Alternatives

**Retain jsdom and all browser setup for every file.** This keeps one environment
but initializes DOM and database resources for algorithms and protocol cases
that do not use them.

**Infer Node eligibility from filenames or all API tests.** Some plain TypeScript
files use DOMParser, IndexedDB, browser storage or window-relative channel and
invitation URLs. The explicit inventory keeps these dependencies visible and
leaves new files under the complete UI setup until reviewed.

**Remove file isolation or share mutable fixtures.** This changes ownership of
module state, mocks, browser storage and asynchronous cleanup across files.
Environment selection avoids that lifetime change.

**Consolidate mutation lifecycle matrices in the same change.** Their shared
lifecycle is a separate assertion-ownership decision with action-specific gate,
route and result checks. Environment selection preserves those matrices and
addresses preparation cost independently.

## Consequences

Browser-independent files initialize Node and their small cleanup hook. UI and
persistent-cache tests keep their existing environment and cleanup proof.
Maintainers must review the explicit Node inventory when a selected file gains
a browser dependency. Keeping the projects complementary prevents a file from
being executed twice or omitted when it changes category.

Environment preparation can consume less CPU without shortening the workflow's
critical browser job. Complete constrained-container measurements and hosted
job observations have separate boundaries; a lower initialization count alone
is not an end-to-end CI speed claim. Required coverage, test failure and cleanup
failures retain their existing effect on the quality result.
