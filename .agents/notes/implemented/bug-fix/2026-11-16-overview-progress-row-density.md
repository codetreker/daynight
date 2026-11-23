# Agent Note: Overview Progress Row Density

Status: implemented

## Problem

The overview progress list leaves enough vertical space around short rows that
fewer outcomes fit on screen, while readers still need to see full titles,
standalone scope, counts and progress and operate each row.

## Decision

The shared overview button row has a 60px minimum height and reduced vertical
padding on desktop and narrow screens. Content can increase its height. The
[Web design](../../../../docs/design/daynight-web.md) owns the layout values,
and the [specification](../../../../docs/spec/daynight-web.md#项目整体进度)
owns readability and navigation requirements.

## Alternatives

**Keep the 70px minimum.** This preserves the former spacing but fits fewer rows
in the same viewport.

**Use a fixed height.** This would constrain wrapped titles and the standalone
scope, risking clipped content at narrow widths.

## Consequences

Short desktop rows use less space while longer content can grow naturally. The
shared renderer retains existing status, progress and navigation behavior; actual
browser geometry and interactions must be verified at supported widths.
