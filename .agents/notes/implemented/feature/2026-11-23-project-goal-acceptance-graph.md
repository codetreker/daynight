# Agent Note: Project Goal Acceptance Graph

Status: implemented

## Problem

Project readers need to see which Goal outcomes precede other Goals, including
isolated active Goals and finished prerequisite context. The existing Goal
overview graph describes ordinary child Task execution, so its membership and
readiness rules cannot describe Goal acceptance. Detail receipts also do not
observe acceptance edges and cannot supply a complete graph baseline.

## Decision

The project Goals toolbar opens a separate acceptance graph of synchronized
project-local Goals. Active Goals are roots; their direct prerequisites remain
visible even when completed or cancelled. Goal `dependsOn` supplies actual
acceptance edges, while ordinary child Task graphs keep their existing members,
execution rules and URLs.

The graph consumes the existing committed TaskSync baseline. Opening, closing
and local canvas actions do not install another synchronization lifecycle or
change requests and watermarks. Detail receipt projections remain separate.
Local inspection describes only known project relationships and distinguishes
satisfied prerequisites from known blockers; the server retains the complete
acceptance decision.

Goal-specific projection, cards and inspection reuse neutral geometry, edge
painting, semantic highlights, toolbar and dialog mechanisms. Valid selection
and viewport survive updates, and an existing position anchors topology changes.
Following an inspector relationship transfers focus to the persistent inspection
heading without scrolling before the changing relation list can remove its
trigger. The programmatically focusable heading remains outside ordinary Tab
order and keeps the graph's Escape and fullscreen handling reachable.
Goal Details use the existing project reading owner and restore their actual
graph trigger. The [relationship design](../../../../docs/design/goal-dependencies.md#项目-goal-验收图)
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

## Consequences

Readers can inspect project-local acceptance relationships without changing
ordinary Task graphs or synchronization traffic. Local data cannot establish
global acceptance because hidden and cross-project prerequisites belong to the
independent authorized relationship reader. Goal presentation has its own
projection and cards while sharing layout and reading mechanics; updates preserve
useful interaction state without treating retained content as authorization.
