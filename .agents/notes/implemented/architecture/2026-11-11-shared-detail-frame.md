# Agent Note: Shared detail frame and overlay ownership

Status: implemented

## Problem

Task details retain drafts, attachment selection and scroll positions through
layout changes. Nested detail portals need the same continuity while ensuring
that only the active child controls focus and keyboard dismissal. DOM ancestry
alone does not identify a parent when both layers render in separate portals.
Mixed graph, detail and confirmation layers also need to stay visually above
their actual parent; component-specific CSS levels cannot represent arbitrary
nested reading depth or a parent that later enters fullscreen.

## Decision

The shared detail frame provides the semantic surface, kept-mounted slots,
fullscreen scroll capture and restoration, and an overlay lifecycle hook. Task
details use these facilities while retaining their own Session, Steps and data
controllers. Overlay ownership follows an explicit React context across portals.
Each registered child holds an inert lease on its parent; keyboard handling and
the attachment frame bridge check the active leaf. Registered modal layers also
provide their actual visual surface. A visual lease preserves that surface's CSS
base and recursively places it above its registered parent's current surface,
including parents registered later and fullscreen re-registration. Releasing the
lease restores the original inline z-index when the lease still owns that value
and recalculates remaining descendants. Graph shells, detail overlays and
confirmations use this shared lease, keeping visual and keyboard ownership aligned.
Modal body scroll locks remain
counted across layers. The opening workspace remains responsible for restoring
focus to a surviving entry point.

## Alternatives

**Infer ownership from DOM ancestry.** Separate portals are siblings in the DOM,
so this cannot identify and isolate the parent detail surface.

**Keep the modal lifecycle in each detail implementation.** Independent focus,
inert and keyboard handlers can compete when a child opens above a parent.

**Assign fixed CSS stacking levels to each modal kind.** A detail opened from a
child graph can lie behind that graph even while logical ownership correctly
gives the detail keyboard control. Deriving the visual lease from the actual
registered parent supports mixed nested readers without a depth guess.

## Consequences

Ordinary Task and Goal surfaces use the shared frame while retaining separate
content and execution ownership. Nested consumers supply their actual parent
through the overlay context and preserve their own content identity. The
visual surface lease keeps arbitrary graph/detail/confirmation nesting visible
and restores component CSS ownership when a layer closes. The
[Goal browsing decision](../feature/2026-11-11-goal-browsing.md) records scope
projection and typed dispatch. Native PDF
keyboard handling remains subject to the browser reader. The earlier
[fullscreen decision](../../archived/feature/2026-10-25-task-detail-fullscreen.md)
records the original layout and continuity trade-offs.
