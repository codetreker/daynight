# Agent Note: Detail Information Typography

Status: implemented

## Problem

Task and Goal detail information asides mix heading and content sizes, making
secondary information compete with the description and obscuring the hierarchy
between section titles and their contents. The same information moves below the
description on narrow screens and needs the same hierarchy there.

## Decision

Task and Goal information asides inherit `xs` for content and use `sm` for
visible top-level section titles. Nested Goal dependency headings remain semantic
headings but inherit the content size. Shared tags, buttons and Task pull request
pagination select that size only inside these asides. Tag editor text inputs in
these asides use the shared touch input adjustment, including its 16 CSS pixel
minimum, without changing their hit areas. The [Web font size scale](../architecture/2026-11-20-web-font-size-scale.md)
continues to own the sizes and scaling rules.

## Alternatives

**Set each content element independently.** Repeated selections make new
information and states easy to omit and allow the two asides to drift apart.

**Change shared controls globally.** Tags and buttons serve other interfaces with
independent typography needs, so a global change would extend beyond the detail
information hierarchy.

## Consequences

The hierarchy follows the information as it reflows and preserves semantic
headings and existing interactions. Shared components retain their other consumers'
sizes. Browser checks are needed to verify the cascade, touch input adjustment,
long content and interaction states at different root sizes.
