# Agent Note: Project Goal Acceptance Graph

Status: implemented

## Problem

Project readers need to see which Goal outcomes precede other Goals, including
isolated active Goals and finished prerequisite context. The existing Goal
overview graph describes ordinary child Task execution, so its membership and
readiness rules cannot describe Goal acceptance. Detail receipts also do not
observe acceptance edges and cannot supply a complete graph baseline. Direct
relationships may cross Projects, and independent authorized reads can finish at
different times or lose access while a graph remains visible.

## Decision

The project Goals toolbar opens a separate acceptance graph. Active Goals are
roots; their direct prerequisites remain visible even when completed or
cancelled. Synchronized Goal `dependsOn` supplies project-local acceptance edges,
while ordinary child Task graphs keep their existing members, execution rules
and URLs. The existing committed TaskSync baseline remains separate from detail
receipt projections. Opening, closing and canvas actions do not install another
synchronization lifecycle or change requests and watermarks.

A graph-owned relationship session calls the existing Goal relationship GET for
qualified active roots. It displays the local graph first, limits concurrent
sources to four and reads each source's successor pages sequentially. Complete
prerequisites and accumulated readable successors form session-only
contributions. Source phases distinguish pending coverage, partial results,
failures, unsupported reads, withdrawal and conflicting observations. There is
no graph polling loop; root/version changes, qualified reentry and explicit
retry drive reads, and closing cancels queued and in-flight work.

External cards retain the API's actual Project, Goal, title and status without
invented Task versions or child progress. Only synchronization supplies internal
edges. Hidden prerequisites remain inaccessible indicators, and local or partial
coverage cannot prove global acceptance. The service continues to own the final
completion decision. Subject, source generation and history fences qualify each
publication; trusted withdrawal clears affected nodes, edges and inspection data
and cancels pages that could otherwise restore them.

Candidate external contributions are checked together with current synchronized
edges. When independently read edge reversal would create a cycle, the conflicting
contribution is rejected while the legal local graph and valid reading state
remain available for retry. Retained presentation is distinct from the current
qualified baseline and cannot authorize new relationship or detail reads.

Goal-specific projection, cards and inspection reuse neutral geometry, edge
painting, semantic highlights, toolbar and dialog mechanisms. Valid selection
and viewport survive updates, and an existing position anchors topology changes.
Following an inspector relationship transfers focus to the persistent inspection
heading without scrolling before the changing relation list can remove its
trigger. The programmatically focusable heading remains outside ordinary Tab
order and keeps the graph's Escape and fullscreen handling reachable.
Goal Details use the existing detail and draft reading layers and restore their
actual graph trigger. The [relationship design](../../../../docs/design/goal-dependencies.md#项目-goal-验收图)
owns the mechanism and the [Goal requirements](../../../../docs/spec/daynight-goals.md#goal-验收依赖图)
own visible behavior.

## Alternatives

**Reuse the ordinary Goal child-Task graph as the acceptance graph.** Its Parent
membership, execution readiness, activity and ordinary external-edge semantics
would misrepresent Goal outcomes. Dedicated Goal presentation can reuse the
neutral mechanical components without inheriting those rules.

**Open another TaskSync reader for the graph.** A second owner would add requests
and independently manage the same project watermark. Observing the existing
committed baseline keeps graph actions independent of synchronization scheduling.

**Use detail-projected summaries as graph facts.** Goal details do not carry
acceptance edges. Keeping the graph on synchronized facts prevents a metadata
receipt from changing relationships before normal project reconciliation.

**Reuse the description's relationship hook for every source.** That reader owns
a polling interval and requires admitted Goal detail content. Applying it to
graph roots would add repeated relationship polling and unnecessary detail
qualification. The graph session can reuse the raw authorized API while owning
its finite source scheduling and cancellation.

**Represent external Goals as complete Task summaries.** The relationship API
does not provide their business versions, timestamps or child progress. A narrow
external node keeps rendering truthful and prevents made-up fields from becoming
cache or detail admission evidence.

## Consequences

Readers see the local graph immediately and readable direct cross-project
context as it arrives, without changing ordinary Task graphs or synchronization
traffic. Relationship reads add bounded per-source network work and hold only
online-session data. Independent pages do not form a global snapshot, so changed
revision pages and graph cycles remain explicit recoverable failures. Local and
partial information cannot establish global acceptance. Shared geometry and
reading mechanics preserve useful interaction state without treating retained
content as authorization or supplying nonexistent external summary facts.
