# Agent Note: Markdown and Mermaid typography

Status: implemented

## Problem

Shared Markdown appears in readers with different inherited text sizes. Mermaid
diagrams are independent SVG images and cannot inherit the surrounding page's
font settings, so a fixed renderer size also fails to follow browser preferences.

## Decision

Markdown selects `sm` for body text, `lg` for headings and `xs` for footnote
references and backlinks. The Mermaid adapter measures the shared scale outside
the reader and supplies resolved sizes before the engine lays out each diagram.
Its configuration and type-specific styles use those measurements; Packet also
receives geometry sized for the measured text. Same-source resizing retains the
current image until a replacement succeeds. The [shared Markdown design](../../../../docs/design/shared-markdown.md#mermaid-图表)
owns the rendering and resource lifecycle.

Sequence numbering and titles reserve space from measured text. The pinned
Mermaid patch measures XY line point labels before assigning axis ranges, using
the measured body size and expanding the canvas when needed. Unlabeled plots
retain the engine's original layout. A label layout requiring more than 16,384
CSS pixels on either axis is refused as a local complexity error.

## Alternatives

**Use inherited CSS alone.** The Blob SVG is a separate document and cannot
inherit the reader's computed values.

**Rewrite text after rendering or scale the whole SVG.** Mermaid has already
calculated its geometry by then, so text can clip or the image can lose readable
dimensions. Supplying sizes before layout preserves the engine's measurements.

## Consequences

Browser font preferences affect both Markdown and diagram text without changing
stored source. The adapter depends on the pinned Mermaid configuration and SVG
selectors; browser tests must verify actual independent documents and geometry
when the engine changes, including the version-specific XY patch. Static policy constrains configuration sources but
cannot prove the rendered output.
