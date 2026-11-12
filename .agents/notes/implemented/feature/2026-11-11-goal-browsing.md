# Agent Note: Goal browsing and scope projection

Status: implemented

## Problem

A Goal owns Tasks independently of their ordinary dependency chains. A reader
needs its actual Tasks, progress and shared materials without losing the complete
chain or treating a Goal as an executable Task. A chain can cross Goal boundaries,
including a scope containing only one of its members.

## Decision

The Web classifies the complete ordinary graph before selecting a Parent scope.
Lists count and render each scoped Task once while retaining the complete chain
representative and witness for graph navigation. A typed detail loader selects
the Goal or ordinary Task surface before mounting execution controllers. The
Goal retains its Tasks, attachment and discussion controllers for the lifetime
of that view; shared overlay ownership isolates nested graph and Task portals.
The [standalone reading-history decision](2026-11-11-standalone-resource-reading-history.md)
places standalone Goal child selections in the page history while preserving
those owners. Cross-scope navigation uses the target's actual Parent and locates its Task in the destination. Shared scoped chain,
member and standalone rows accept explicit presentation identities; their list
owners retain navigation, pagination and expansion control. A scoped chain uses
only its explicit members for progress, while the full component supplies worker
indication, the representative supplies its title and a scoped member supplies
the graph witness.
Instance identities also separate DOM associations and Session visibility keys,
without starting Session reads where no provider exists.
The [Goal description tab decision](2026-11-12-goal-description-tab.md) separates
description reading from Task browsing while retaining these owners. The
[Web design](../../../../docs/design/daynight-web.md) describes the current
presentation and lifecycle.

## Alternatives

**Build a graph separately for each Goal.** Removing out-of-scope vertices first
would turn a cross-scope chain's single visible member into a standalone Task and
lose the original chain and edge classification.

**Embed complete task lists in each scope.** Their pagination, graph host and
list ownership would be duplicated, and resource-based DOM identities would
collide when one chain appears in several scopes. Shared rows preserve those
responsibilities in their existing owners.

**Mount ordinary Task details and hide execution controls for Goals.** Their
Session and Steps controllers would still start against a resource that does not
support execution, and their lifetime would not match Goal content.

## Consequences

Progress follows actual ownership without duplicating representatives, while the
full graph remains available for context. Scope projections, explicit row identities and portal
ownership add client state and require history retirement to cover shared
materials. Goal creation and changes to status or ownership require their own
public Web controls and API delivery.
