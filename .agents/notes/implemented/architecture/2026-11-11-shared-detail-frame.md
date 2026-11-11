# Agent Note: Shared detail frame and overlay ownership

Status: implemented

## Problem

Task details retain drafts, attachment selection and scroll positions through
layout changes. Nested detail portals need the same continuity while ensuring
that only the active child controls focus and keyboard dismissal. DOM ancestry
alone does not identify a parent when both layers render in separate portals.

## Decision

The shared detail frame provides the semantic surface, kept-mounted slots,
fullscreen scroll capture and restoration, and an overlay lifecycle hook. Task
details use these facilities while retaining their own Session, Steps and data
controllers. Overlay ownership follows an explicit React context across portals.
Each registered child holds an inert lease on its parent; keyboard handling and
the attachment frame bridge check the active leaf. Modal body scroll locks remain
counted across layers. The opening workspace remains responsible for restoring
focus to a surviving entry point.

## Alternatives

**Infer ownership from DOM ancestry.** Separate portals are siblings in the DOM,
so this cannot identify and isolate the parent detail surface.

**Keep the modal lifecycle in each detail implementation.** Independent focus,
inert and keyboard handlers can compete when a child opens above a parent.

## Consequences

The ordinary Task exercises the shared frame without mounting Goal data or
execution controllers. New nested consumers must supply their actual parent
through the overlay context and preserve their own content identity. Native PDF
keyboard handling remains subject to the browser reader. The earlier
[fullscreen decision](../../archived/feature/2026-10-25-task-detail-fullscreen.md)
records the original layout and continuity trade-offs.
