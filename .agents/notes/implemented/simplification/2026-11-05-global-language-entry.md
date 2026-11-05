# Agent Note: Global Language Entry Ownership

Status: implemented

## Problem

The interface language is one application preference, but repeated selectors in
business overlays compete with titles and actions for space. The same preference
feedback and retry controls also appear in each copy. Presentation modes do not
change who owns the preference, and placing controls in overlay headers makes the
entry depend on the surface currently open.

## Decision

The [UI principles](../../../../docs/ui-design.md#keep-global-language-selection-at-page-level)
assign the main Web interface's global language entry to its page header.
Standalone pages retain their existing entry locations. Dialogs, overlays and
fullscreen modes do not create, copy, move or give the selector separate
mode-dependent visibility. Overlay headers are not the main page header.
Existing page-wide fullscreen layout and modal isolation remain in force.

Shared `ManagementDialog` inherits the current language without a local selector
or its preference notice and retry. The page's selector continues to own that
feedback. Language changes still update mounted dialog content without changing
business state or pending operations. This partially supersedes the placement
policy in the [bilingual interface decision](../feature/2026-10-22-web-bilingual-interface.md),
whose original rationale and runtime guarantees remain relevant.

## Alternatives

**Place a selector in each modal or fullscreen surface.** The original bilingual
integration did this so users could change language while the background was
inert. It duplicates a global preference, its error feedback and its controls in
business surfaces, consuming header space and tying entry placement to the
presentation mode. The shared application locale already supplies translated
content without a local control.

## Consequences

The shared management dialog and its callers no longer offer a local language
entry. Existing focus isolation, keyboard interaction, page entry and preference
failure recovery remain owned by their respective surfaces. The
[graph language entry decision](2026-11-05-graph-language-entry.md) and
[identity revalidation decision](../bug-fix/2026-11-05-revalidation-language-entry.md)
and [attachment confirmation decision](2026-11-05-attachment-confirmation-language-entry.md)
remove those overlays’ duplicate controls. Project creation still contains its
existing selector and needs a separate change to satisfy the UI principle, without changing the
locale runtime or moving the retained page entries. The rule does not require
the page entry to be active while a modal is open or visible when an entire page
region is hidden in fullscreen.
