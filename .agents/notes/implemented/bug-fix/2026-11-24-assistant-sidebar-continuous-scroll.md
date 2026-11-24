# Agent Note: Share sidebar space across assistant and task lists

Status: implemented

## Problem

Four assistants can require internal scrolling while an empty task section leaves
unused sidebar height. A narrow fixed sidebar also spends much of each row on a
decorative avatar and its menu, truncating names and wrapping device labels into
tall rows. Removing the earlier protection against shrinking must not restore the
zero-height assistant list when task content grows.

## Decision

The sidebar keeps its title, creation entry and search outside one scrollable
content region. Assistant rows, assistant tasks and deletion status follow their
existing order inside that region. Both lists use natural content height without
an assistant-specific height cap or an allocation that shrinks rows to fit tasks.
Empty sections reserve no remaining height. This replaces the upper budget and
nested scroll regions from the
[height-budget decision](2026-11-20-bot-list-height-budget.md), while preserving its
protection against zero-height lists.

The sidebar grows with the actual workspace within a bounded width and always
leaves at least 420px for a parallel conversation. Below the existing workspace
threshold, the same mounted panels retain single-column selection and return
behavior. Rows give space to wrapping names and device labels instead of a
decorative avatar; menu targets remain 44px. Compact state slots retain the
[background-update stability](2026-11-24-assistant-background-stability.md)
rules. CSS and the scroll wrapper do not create another Session identity or
alter observation, draft, menu or deletion ownership.

The [management design](../../../../docs/design/bot-management-web.md#工作区与列表)
owns dimensions and structure. The
[management specification](../../../../docs/spec/bot-management-web.md#工作区与单栏切换)
owns observable layout and reachability requirements.

## Alternatives

**Keep the independent height cap.** It prevents task growth from hiding assistant
rows, but cannot use space left by an empty task section. Increasing its numeric
limit only changes which viewport and row lengths reproduce the same problem.

**Scroll the whole sidebar without a separate content region.** This also removes
nested scrolling, but moves the title, creation entry and search out of view when
browsing a long inventory. Keeping those controls outside the scrolling content
preserves direct access to filtering and creation.

## Consequences

Short inventories can display all their rows when the sidebar has sufficient
space. Long inventories require scrolling past assistants to reach tasks; task
controls do not have a separately reserved visible area. Keyboard focus follows
the existing DOM order and reveals controls in the shared region. Long names and
devices increase natural row height, so no fixed row count is promised on short
screens or with enlarged text. Wider sidebars reduce conversation width only
within the explicit minimum; details still use their own container-based mode
selection. Changes to sidebar scrolling leave timeline reading and Session
continuity with their existing owners.
