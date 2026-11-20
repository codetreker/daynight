# Agent Note: Bounded attachment tree indentation

Status: implemented

## Problem

Deep attachment directories consume the filename column through cumulative list
padding. In a 320px viewport, six directories leave an ordinary filename only
15px wide, forcing character-by-character wrapping and making neighboring files
hard to identify. Shrinking file action targets further compromises touch use.
The inventory and preview must remain usable beside each other.

## Decision

The attachment tree retains native nested directory disclosures and full-path
selection and action identities. Each directory summary and file row receives
its logical depth; CSS applies a capped visual inset directly to that row.
Nested lists contribute no additional indentation. Responsive track widths,
indentation budgets, filename wrapping, metadata rows and action target sizes
are owned by the [attachment design](../../../../docs/design/daynight-task-attachments.md#web-文件树与预览).

This refines the space allocation of the archived
[split-view decision](../../archived/architecture/2026-10-22-task-attachment-split-view.md)
and preserves the expansion ownership of the archived
[directory-disclosure decision](../../archived/feature/2026-10-25-attachment-directory-disclosure.md).
The minimum sidebar width reserves usable text and menu space, while a bounded
proportional track leaves the preview the remaining width. Decorative file
icons yield their space on narrow screens; file size occupies its own line.

## Alternatives

**Keep cumulative nesting padding.** Even smaller per-level spacing eventually
consumes the filename column. A direct per-row cap bounds the cost at any depth.

**Keep the 94px minimum sidebar and shrink action buttons.** The reproduced six-level
layout leaves 15px for the filename and reduces the menu target to 22px wide.
Reserving sidebar width and preserving a 28px target addresses both constraints.

## Consequences

Deep paths remain structurally nested and collapsible, while filenames retain
space after the visual indentation cap. Rows beyond the cap share alignment;
full paths in file actions and preview headers retain their exact identity.
The wider narrow-screen sidebar reduces preview width. Both panes retain their
independent scrolling and existing state owners, so changing viewport size does
not require remounting controls or discarding upload drafts.
