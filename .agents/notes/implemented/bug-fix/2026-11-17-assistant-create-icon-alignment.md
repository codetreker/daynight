# Agent Note: Assistant Create Icon Alignment

Status: implemented

## Problem

The assistant list's create button centered the line box of a plus character,
but its visible strokes could sit off center because glyph metrics vary by font.
The button needs a centered mark without changing its size or create interaction.

## Decision

The button uses a decorative 18px inline SVG with symmetric strokes and
`currentColor`. The button remains responsible for its accessible name, focus,
disabled state and creation action. Its existing flex alignment centers the path
independently of font metrics.

## Alternatives

**Translate the character.** A fixed offset compensates for one font's metrics
but can misalign another font, whose glyph may have a different offset.

**Keep the centered line box.** Centering the text box alone does not center the
visible glyph; the reported rendering exhibited a downward offset.

## Consequences

The mark retains the button's color, including its disabled color, and no longer
depends on the font's plus glyph. The SVG adds explicit geometry to maintain, and
browser rendering and interaction checks remain necessary to verify the result.
