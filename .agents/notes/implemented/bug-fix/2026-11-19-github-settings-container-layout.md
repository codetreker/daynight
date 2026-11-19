# Agent Note: GitHub Settings Container Layout

Status: implemented

## Problem

Project settings retain a navigation column at medium viewport widths. The
remaining GitHub panel can be too narrow for repository information and connection
actions in one row even when the viewport exceeds the mobile breakpoint. Clipping
at the panel edge hides part of the connection button and its label.

## Decision

The GitHub panel body establishes a named inline-size query container. Repository
information and actions stack when its content width is at most 480px and use a
row above that width. The action group wraps within the available width, and
button labels can wrap without truncation. Repository values retain their existing
word wrapping. The containing navigation layout and connection state machine
remain owned by their existing components.

## Alternatives

**Keep a viewport breakpoint.** The existing 600px rule works on small phones but
does not account for the navigation columns at medium widths. Raising that
breakpoint would still couple the component to its host layout.

## Consequences

Connection actions follow the space available to the component, including sidebar
changes, while wide panels retain horizontal placement. Inline-size containment
requires the panel body to receive its width from the host, as it does in the
settings grid. Browser regression checks measure button bounds and exercise the
existing dialogs through the production page with controlled API responses.
