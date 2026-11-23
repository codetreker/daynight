# Agent Note: Attachment Sidebar Typography

Status: implemented

## Problem

Attachment sidebars need a consistent visual hierarchy across Task and Goal,
while Session record labels and file rows must remain legible as browser text
preferences increase.

## Decision

The shared attachment sidebar selects `sm` for section headings, refresh
controls and the upload disclosure, and `xs` for complete Session record labels
and file rows, including their action triggers. The Session record selection is
scoped to the attachment panel; Goal does not add a record section. Other
attachment views and controls retain their existing sizes. The
[shared typography decision](../architecture/2026-11-20-web-semantic-typography.md)
owns the scale and its browser-preference behavior.

## Alternatives

**Change Session record buttons globally.** This would also alter the Session
tab, which has a separate presentation and is outside this sidebar decision.

## Consequences

Task and Goal use the same attachment hierarchy, and the selected sizes scale
with the browser root. Row padding, action hit areas and interaction behavior
remain independent of the text size. Narrow layouts still need wrapping and
browser verification for long filenames and enlarged text.
