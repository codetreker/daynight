# Agent Note: Description Reading Container

Status: implemented

## Problem

Task and Goal descriptions can be long structured documents, but their rendered
content did not have a clear visual boundary from surrounding detail information.

## Decision

Nonempty Task overview and Goal descriptions share a bordered reading container
in page, dialog and fullscreen presentations. The container reduces padding on
narrow screens and leaves Markdown's local overflow owners intact. Empty states,
Steps and attachment readers retain their existing presentation. The
[Web requirements](../../../../docs/spec/daynight-web.md#描述与附件引用) own the
visible behavior.

## Alternatives

**Style every Markdown renderer.** Steps and attachments use the same renderer,
so a global border would change unrelated reading surfaces.

## Consequences

Both descriptions remain visually consistent without changing Markdown parsing,
attachment navigation or local scrolling. The additional container consumes
horizontal space, especially on phones, so its padding is reduced at narrow widths.
