# Agent Note: Preserve List State During External Graph Navigation

Status: implemented

## Problem

Following an external prerequisite can leave the task list on a different page
with different filters after the graph closes. Goals are sorted with unfinished
work before terminal work, so navigating to a completed Goal on a later page can
leave only completed rows visible even though unfinished tasks remain in the
project. The reader loses the list context from which the graph was opened, and
repeated Goal hops can also replace the focus destination for closing the graph.

The [one-hop navigation decision](../feature/2026-11-07-external-graph-navigation.md)
originally moved the list to the destination because graph validity depended on
its representative being visible there. Reliable graph navigation and retaining
the reader's list context both require a destination outside the displayed list
to remain accessible.

## Decision

ProjectPage owns an active actual-task `openChainWitness` for the graph resource.
It resolves that task through the complete `componentByTask` index and requires
a multi-member ordinary component while Task list / Task chains is active.
Filtered and off-page components remain valid graph resources. A missing task or
single-member component closes the graph; leaving the corresponding view clears
its opening state. Representative changes preserve a still-valid actual-task
witness through ordinary-component merges and splits.

An external card's multi-member destination directly replaces the graph witness.
It uses the destination Goal's direction preference and initializes that Goal's
exploration and inspection while retaining the graph-dialog and fullscreen
owners. A standalone destination closes the graph and opens the existing task
reader. Navigation does not append external ancestry to the source canvas.

Status and assignee filters, page, list rows, child disclosure and scroll belong
to the list. External navigation leaves them intact throughout navigation and
after close. `listTarget` belongs only to explicit Overview-to-list navigation,
which still reveals a target by adjusting obscuring filters, selects its page,
and performs the existing scroll, focus and highlight operation.

ChainList stores the original graph button `opener` and original list-task
witness `openedTask` separately from the active graph witness. Both remain bound
to the original list opening across successive external Goal hops. Closing
focuses the connected, visible original button with `preventScroll`. If it has
disappeared, the original list witness resolves to its latest representative on
the current visible page; fallback then uses the first visible Goal disclosure,
list region and active category tab.

The [external dependency requirements](../../../../docs/spec/daynight-external-dependencies.md),
[inspection design](../../../../docs/design/daynight-task-inspection.md) and
[Web design](../../../../docs/design/daynight-web.md) own the full behavior and
mechanism. One-hop P, complete ancestor H, four task states, ordinary-member Goal
progress and existing detail-reader ownership retain their meanings.

## Alternatives

**Keep locating the external Goal in the task list.** Clearing only obscuring
filters and selecting the destination page makes the Goal reachable through a
visible list entry, as the original implementation required. It also changes the
reader's retained list context. A completed destination can move the list to a
page containing only completed Goals, and replacing the opener on each hop sends
close focus to the destination rather than the source. Graph access therefore
uses the complete component index independently of list display eligibility.

## Consequences

Readers can inspect a filtered or off-page Goal without changing their current
list. Separate graph and list witnesses preserve the original close destination
while allowing the active graph to follow topology changes. Graph validity must
explicitly retain the multi-member guard: list-page membership no longer
incidentally closes a graph whose witness becomes standalone.

An original opener removed by a genuine snapshot or list change cannot receive
focus; the existing visible-list fallback handles that case without relocating
the list. External navigation introduces no API read, stored preference, task
status change or dependency reclassification. Ordinary list reconciliation and
explicit Overview positioning keep their existing behavior.
