# Agent Note: One primary status for ordinary Task rows

Status: implemented

## Problem

Ordinary Task rows put current Session copy beside the lifecycle label. A working
Task repeats its progress state, and notice with an attention flag repeats the
same response need. The project standalone, expanded chain, expanded Goal and
personal list need a concise status without losing lifecycle or reading access.

## Decision

The shared row delegates one primary status to `TaskRowStatus`. For in-progress
Tasks it selects notice first, then valid attention, then the specific normalized
observation, then lifecycle fallback. Other lifecycles show their own text and
have no Session entry. Phrases have no fixed Session prefix or appended lifecycle
or attention suffix. Accessible text retains the genuine lifecycle and the entry
action without repeating the selected phrase.

This replaces the copy policy from the
[warning deduplication decision](../bug-fix/2026-11-20-session-warning-attention-copy.md).
That decision treated notice and attention as distinct facts; the native
projection produces both from one state, so a response phrase now takes priority.
The [shared row](../architecture/2026-11-15-shared-project-task-row.md) continues to
own common presentation, while adapters retain admission, clocks and freshness.

Only a current admitted entry and caller callback make the complete phrase an
underlined native button. Label changes preserve its node and focus; withdrawing
the entry uses the row's existing title focus recovery. Pause, readiness,
blocking and overdue warnings remain independent. Overdue styling retains the
selected phrase, including Working, and the accessible in-progress lifecycle.
The [Session design](../../../../docs/design/task-session-status.md#普通-task-行)
owns the full rule and locale wording.

## Alternatives

**Deduplicate inside each adapter.** The same ordinary Task can appear through
project and personal projections. Independent display decisions would diverge
while duplicating rules that need no source or protocol change.

**Always show In progress.** This removes repetition but hides current work,
response needs and observation failures from list scanning.

## Consequences

All four ordinary row contexts share one phrase and preserve real task state,
filtering, counts, detail views, summaries and Session eligibility. The visual
lifecycle label is absent when a more specific observation is selected, so the
accessible lifecycle remains necessary. Presentation requires no new requests,
storage, background work or deployment ordering. Graph cards, details, chain and
Goal summary labels retain their own rules.
