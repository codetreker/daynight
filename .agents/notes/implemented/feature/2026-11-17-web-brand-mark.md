# Agent Note: Web Brand Mark

Status: implemented

## Problem

Web brand entries used different circular marks, and browser tabs had no matching
icon. The visual identity needed to remain recognizable at small sizes on both
light and dark surfaces without changing navigation or authentication behavior.

## Decision

Web brand entries share a decorative D letter mark with a separated stem and arc.
Callers select the palette for their surface and layouts retain their own sizing.
The browser favicon uses the same geometry and adapts its stem to the browser
color scheme. Vite emits it as a hashed SVG under `/assets/`, so the existing
asset publication and embedded Web service deliver it. The
[shared brand design](../../../../docs/design/web-visual-tokens.md#品牌标志)
owns the visual contract.

## Alternatives

**Horizon and orbit marks.** These visual directions were considered alongside
the D letter mark. The selected letter makes the product initial recognizable
while retaining separated shapes at small sizes.

**A root-level favicon.** A public root file would fall outside the existing
published and embedded `/assets/` boundary and require separate delivery handling.

## Consequences

The shared component keeps page geometry and colors consistent, while the
standalone favicon duplicates the geometry for browser loading. Changes to the
mark must keep both representations aligned. Existing links and accessible names
remain owned by their parent elements.
