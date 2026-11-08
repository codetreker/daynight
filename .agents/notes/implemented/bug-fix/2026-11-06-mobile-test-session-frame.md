# Agent Note: Mobile Test Session Page Frame

Status: implemented

## Problem

The standalone Test Session page spends a large share of a phone viewport on
page padding, a back link, a repeated heading, and a bordered Session card.
These consume reading space even though the workspace breadcrumb already names
the page. Compact rules based only on viewport height miss portrait phones.

## Decision

At viewport widths up to 600px, the Test Session detail route has a dedicated
shell class that removes its content padding. The page retains a single-line
back link with a minimum 36px hit area and a visually hidden, accessible `h1`.
The Session fills the remaining content area without a card border or radius.
The [Controller requirements](../../../../docs/spec/controller-test-sessions.md#session-view)
own the visible behavior and state coverage.

The dedicated class distinguishes Test Session detail from assistant pages that
reuse the general Session shell. The width rule follows the short-window rules
so portrait and short mobile windows both remove the outer bottom inset.
Existing Session DOM, fullscreen positioning, focus restoration, and Escape
handling remain the owners of interaction behavior.

## Alternatives

**Keep only the short-window media query.** Portrait phones exceed its 500px
height threshold, retaining the very spacing that limits their reading area.

**Apply padding removal to the shared Session shell.** Assistant pages also use
that class, so this would change an unrelated layout and couple its spacing to
standalone Test Session requirements.

**Remove the heading from the DOM.** This would remove the page-level heading
from assistive navigation. Visual clipping recovers the space while preserving
that structure.

## Consequences

Phone layouts recover horizontal and vertical reading space in online, archived,
loading and error states. The sidebar still owns its existing width, and Session
header and composer layout remain independent constraints on timeline height.
Tablet and desktop layout remain unchanged. Browser regression checks exercise
the actual Test Session route at the breakpoint, phone and desktop sizes,
including keyboard return navigation and fullscreen restoration; simulated
viewports do not establish physical-device or software-keyboard behavior.
