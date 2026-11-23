# Agent Note: Goal browsing and scope projection

Status: implemented

## Problem

A Goal owns Tasks independently of their ordinary dependency chains. A reader
needs its actual Tasks, progress and shared materials without losing the complete
chain or treating a Goal as an executable Task. A chain can cross Goal boundaries,
including a scope containing only one of its members.

## Decision

The Web classifies the complete ordinary graph before selecting a Parent scope.
Lists count and render each scoped Task once; chain views retain the complete
representative and witness for graph navigation. A typed detail loader selects
the Goal or ordinary Task surface before mounting execution controllers. The
Goal retains its description, attachment and discussion controllers and any
admitted nested reading owner for the lifetime of that view; shared overlay ownership isolates nested graph and Task portals.
The [standalone reading-history decision](2026-11-11-standalone-resource-reading-history.md)
places standalone Goal child selections in the page history while preserving
those owners. Cross-scope navigation uses the target's actual Parent and action:
Details opens its Task under that Goal, while Expand opens the complete chain
for a multi-member target or Task details for a single member. The Goal and
corresponding child or graph are selected together. Shared scoped chain,
member and standalone rows accept explicit presentation identities; their list
owners retain navigation, pagination and expansion control. A scoped chain uses
only its explicit members for progress, while the full component supplies worker
indication, the representative supplies its title and a scoped member supplies
the graph witness.
Instance identities also separate DOM associations and Session visibility keys,
without starting Session reads where no provider exists. Project Goal rows share
the same projection between summary and inline contents. The [flat Goal list
decision](../simplification/2026-11-13-goal-flat-list.md) replaces nested chain
disclosures with direct member rows and retains the existing page Session store
and visibility registration without additional HTTP reads. Each Goal owns its
disclosure while the active category hosts one graph. The original source Goal and trigger remain separate from the
current graph witness across navigation; visible fallbacks do not alter filters
or pagination.
The [Goal description tab decision](2026-11-12-goal-description-tab.md) originally
separated description reading from Task browsing. The
[Goal detail information decision](2026-11-12-goal-detail-information.md) keeps
task rows in the project Goal list and presents description and statistics in
detail while retaining the nested reading owners. The
[Web design](../../../../docs/design/daynight-web.md) describes the current
presentation and lifecycle.
The [Goal overview graph decision](2026-11-13-goal-overview-graph.md) adds a separate complete Goal graph; Goal detail statistics retain ordinary chain classification.
The [Goal status background decision](2026-11-12-goal-status-backgrounds.md)
uses the Goal's own state for its list heading while keeping scoped progress
independent. The [Goal row disclosure decision](../bug-fix/2026-11-13-goal-row-disclosure.md)
makes the heading body the disclosure and keeps detail and graph as separate
actions. The [Goal execution summary decision](2026-11-13-goal-execution-summary.md)
uses direct children for the heading's status count and Worker claim indicator.
The [completion-progress decision](../bug-fix/2026-11-13-completion-progress-excludes-cancelled.md)
projects scoped counts without removing cancelled members.

## Alternatives

**Build a graph separately for each Goal.** Removing out-of-scope vertices first
would turn a cross-scope chain's single visible member into a standalone Task and
lose the original chain and edge classification.

**Embed complete task lists in each scope.** Their pagination, graph host and
list ownership would be duplicated, and resource-based DOM identities would
collide when one chain appears in several scopes. Shared rows preserve those
responsibilities in their existing owners.

**Embed Goal details in the list.** That would bring detail controllers, writes,
attachments and drafts into each row, changing their lifetimes. Separate detail
reading retains those owners while inline rows expose the scoped work.

**Mount ordinary Task details and hide execution controls for Goals.** Their
Session and Steps controllers would still start against a resource that does not
support execution, and their lifetime would not match Goal content.

## Consequences

Progress follows actual ownership without duplicating representatives, while the
full graph remains available for context. Scope projections, explicit row identities and portal
ownership add client state and require history retirement to cover shared
materials. Goal creation and changes to status or ownership require their own
public Web controls and API delivery.
