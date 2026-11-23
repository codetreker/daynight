# Agent Note: Compact Project Task Filter Text

Status: implemented

## Problem

Ordinary project task toolbars mix labels, selected values and count badges at
different sizes. Pointer-based font changes also make the same filter occupy
different visual space despite retaining a usable target. The toolbar needs one
scalable size for its visible labels and closed values across standalone tasks,
chains and Goals, including both Goal tag entries.

## Decision

The ordinary `.project-task-filters` toolbar selects `--text-xs` for visible
labels, closed selection values and entry counts with both fine and coarse
pointers. The public selection stylesheet owns the scoped filter trigger choice;
native selects inherit from their wrappers. Page CSS owns the adjacent labels.
The [component design](../../../../docs/design/native-select.md) defines the
ownership and [typography requirements](../../../../docs/spec/web-typography.md)
define root scaling.

This partially supersedes the [narrow filter font decision](2026-11-20-project-task-filter-font.md):
its shared `responsive-target` mode still separates fine-pointer text from touch
geometry for expression search, while the ordinary toolbar selects `xs` within
its own scope. Shared size values and control defaults remain unchanged.
Expanded panels, external selected chips and errors retain their own sizes.
The [compact toolbar layout](2026-11-20-project-task-filter-layout.md) retains
its container breakpoints, responsive hit targets and focus ownership.

## Alternatives

**Change shared filter density or touch defaults.** Other controls and expression
search use those defaults. Changing them would extend the typography decision
beyond the ordinary project toolbar.

**Set the font on the whole toolbar.** Inherited text could reach menus, chips
or error feedback. Selecting labels and standard entry hosts isolates the
visible text while keeping each expanded surface's owner intact.

## Consequences

Labels, closed values and badges scale together from 12px at a 16px browser root
to 18px at a 24px root. Touch targets preserve their existing minimum dimensions
even though the ordinary toolbar no longer uses a 16 CSS px text minimum.
Expression search and text-entry minimums retain their existing policy. Long
values still need truncation with complete accessible names, and narrow layouts
and enlarged browser fonts still require browser geometry validation.
