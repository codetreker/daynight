# Agent Note: Member Section Heading

Status: implemented

## Problem

The members section repeated the settings identity and project name already
shown by its workspace. On narrow screens the two page-level headings and
separate invitation row displaced the member search below the first screen.

## Decision

The workspace owns the sole project page heading and its authenticated name
read. The member section uses a second-level heading beside the existing
permission-gated invitation action; the roster has a third-level heading. The
row wraps according to available width, including enlarged browser fonts. The
[workspace design](../../../../docs/design/project-settings.md) owns the
controller and identity boundaries. This builds on the [member integration](../architecture/2026-11-13-project-settings-members.md)
and changes the presentation described by the [project name decision](../bug-fix/2026-11-06-member-project-name.md).

## Alternatives

**Retain the independent page heading.** The legacy members route already
selects the same workspace, so a second page identity duplicates long names and
pushes the roster down without adding context.

## Consequences

The section is more compact while the workspace retains its name fallback,
access withdrawal and independent member operations. Very narrow containers or
enlarged text can still wrap the invitation onto a separate row.
