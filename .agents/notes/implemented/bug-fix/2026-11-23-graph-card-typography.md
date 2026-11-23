# Agent Note: Graph Card Typography

Status: implemented

## Problem

Dependency graph cards mix auxiliary text sizes, making status and action labels
compete with task titles in the limited card area. Both chain and Goal graphs
need the same hierarchy while retaining readable text at larger root sizes.

## Decision

Both graphs use `--text-sm` for card titles and `--text-xs` for other visible
card text. Node-local rules select the auxiliary size for shared status and
readiness components without changing their other uses. The Details reservation
in the bottom row and the overdue title reservation scale with the auxiliary
size. Card geometry, title line limit, reading hints and interactions remain
owned by the [inspection specification](../../../../docs/spec/daynight-task-inspection.md).
This refines the shared presentation of the [compact readings decision](2026-11-20-compact-graph-readings.md).

## Alternatives

**Change shared status and readiness styles globally.** These components also
appear outside graph cards, where their existing hierarchy remains appropriate.
A global change would alter unrelated interfaces.

## Consequences

Auxiliary labels have a consistent hierarchy and their reserved space follows
browser text preferences. The fixed card geometry still requires browser checks
for truncation and overlap in both languages and at enlarged text sizes.
