# Agent Note: Standalone Resource Reading History

Status: implemented

## Problem

A standalone Goal can open a graph, a child Task and another Goal while retaining
its root URL. Those reading choices were local, so browser Back and Forward could
not retrace them. Child editors and attachment readers must remain usable when a
reading selection changes without leaving their actual resource and host.

## Decision

The standalone resource page records lightweight, identity- and root-bound
reading selections with the existing navigation owner. The root tab and file
remain in the URL; Goal graph, child Task, and external Goal dialog selections
are held in the page history. Typed resource loading still determines which
surface is eligible. Shared Goal and detail components accept controlled
selections. Project-page callers use those same controlled interfaces for their
root detail and Goal children. Ordinary reading
changes push; closing a layer replaces the current entry after the existing draft
admission. Same-resource editors are identified by their resource, host and
presentation, not the history entry. A Project root Task may change draft hosts
when switching between `summary` and `direct` observations, so that transition
requires departure admission even for the same Task ID. A retained detail hook
establishes a new opening when its observation source changes; earlier content
cannot satisfy the new source's admission. Pending and unknown writes retain
their existing reconciliation without replay. Goal roots and children
are judged by their actual hosts rather than the root observation source. A
verified direct Goal retains its typed owner when the graph is temporarily absent;
an available graph that cannot identify the target as a Goal requires draft
admission. An admitted child retains its original reading source for that mount,
while an unadmitted child waits before selecting its source.
A restored summary selection waits for the graph to identify its resource rather
than becoming a direct read while the graph is absent. An existing summary
reader retains its admitted observation during a temporary snapshot gap, while
the original identity, access and history fences still govern its eligibility.
Retired graphs cannot establish a resource type; ordinary cache changes do not
retire the reader. This preserves the reader and draft without promoting an
unqualified selection.

The [inspection design](../../../../docs/design/daynight-task-inspection.md#独立完整任务详情)
owns the current composition and the [navigation design](../../../../docs/design/daynight-task-steps.md#web-呈现导航与大集合)
owns indexed and native-history boundaries. The [Goal description tab decision](2026-11-12-goal-description-tab.md) extends
the eligible tab selections without changing the root and nested history boundary.
The [Goal detail information decision](2026-11-12-goal-detail-information.md)
removes the detail Task panel while keeping controlled graph and child selections;
cross-Goal Details selects the target Goal and child together, while external
Expand selects that Goal and complete chain graph for a multi-member target.
Unparented chain expansion uses a transient project graph witness; it does not
change the root and nested detail sharing contract.
The account-level in-progress overview uses the same detail and Goal child
owners with an identity-bound reading entry for the selected project, resource
and group pages. Its direct reader does not depend on membership in the filtered
list. A selected project alone owns the full graph and assignee receipt; changing
projects retires that host. Resource retirement also fences earlier overview
entries, and draft admission follows the root and actual child selection.

This extends the shared entry model
in the [account reading-history decision](2026-11-11-account-reading-history.md)
and partially supersedes the dialog-local history boundary in the archived
[standalone detail decision](../../archived/architecture/2026-10-24-standalone-task-detail.md).
The original URL, shared surface and modal focus rationale remain applicable.

## Alternatives

**Encode every nested selection in the URL.** This would change sharing and cold
entry behavior and require an additional encoding and authentication handoff;
the root resource already has an established URL contract.

**Keep child selections only in the component.** This retains local state but
cannot restore the browser's sequence of nested reading choices.

## Consequences

Back and Forward restore reading choices without replaying business operations.
The state contains no business response, draft, permissions or DOM; existing
resource, identity and access lifecycles continue to own admission and cleanup.
Closing does not skip older entries. Standalone nested selections are not a
cross-refresh or shareable-link contract; overview selections restore the current
entry on reload. Native unnumbered entries retain the existing navigation limits.
