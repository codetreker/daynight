# Agent Note: Remove the task detail source footer

Status: implemented

## Problem

A relationship-source explanation consumed reading height in every task detail
panel, including attachments, Steps, discussion and Session. Its small, low
contrast text described overview data even when that overview was hidden. The
same wording also obscured the distinction between independently loaded task
relationships and the project snapshot used by summary-backed openings.

## Decision

The shared task detail surface has no relationship-source footer. Its dedicated
styles and English/Chinese message entries are removed. Existing relationship
headings, partial-result notices, errors and refresh controls continue to explain
the available information where it is used. Data loading and relationship
navigation retain their existing owners.

This supersedes the static footer presentation described by the archived
[fullscreen decision](../../archived/feature/2026-10-25-task-detail-fullscreen.md),
which originally hid that explanation only in short fullscreen or claimed views
to preserve reading space. The source and reading mechanisms remain documented
in the [Web design](../../../../docs/design/daynight-web.md).

## Alternatives

**Keep the explanation behind an overview information button.** This would
remove its permanent height cost but add focus, dismissal and translation
behavior for implementation details already covered by the relationship labels,
partial-result state and technical documentation. An additional explanation can
be reconsidered if those controls leave a user decision ambiguous.

**Keep a more readable footer only in overview.** This improves contrast and
removes repetition across other panels, but still spends overview reading space
on source mechanics without helping the user act.

## Consequences

Dialog, standalone and fullscreen details share the recovered reading space.
There is no additional help control or focus lifecycle. Readers use the existing
relationship states for actionable limitations and the design documentation for
source details; removal does not promise that independently read resources share
one snapshot or change any freshness or write-eligibility rule.
