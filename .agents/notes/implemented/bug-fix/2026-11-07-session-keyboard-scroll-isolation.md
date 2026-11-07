# Agent Note: Session keyboard coverage and scroll isolation

Status: implemented

## Problem

A fullscreen Session used the same visual viewport rectangle for its opaque
surface and its content. Shrinking that rectangle leaves layout-viewport pixels
outside the Session surface, where browser keyboard accessories can expose other
content. Overflow-only body locking also does not preserve root position across
keyboard panning, and inert siblings do not prevent scroll chaining through an
ancestor. Timeline boundary protection alone does not cover composer blanks,
long inputs or menus.

## Decision

Keep the original Session subtree and fullscreen boundary. The opaque root fills
the layout viewport while padding confines its flex content to the visual
viewport. Bot uses the same geometry with its existing inner spacing. The
standalone task result slot reserves content space and remains above the opaque
root. This separates coverage from content layout without reparenting a Session
or changing transport, draft, cursor or native identity ownership.

Session fullscreen additionally acquires counted body-position ownership.
The first owner saves the page coordinates and the specific inline properties
it changes, including their priority, then fixes the body at the negative page
offset. The last owner restores those properties and scrolls instantly to the
saved coordinates. Position ownership is independent of the existing overflow
lock, so an enclosing modal still owns overflow after Session exit.

The Session scroll guard runs in the document bubble phase. React timeline
handlers first observe the original gesture to pause following and request older
history. The guard then prevents only default movement that cannot be consumed
by a scrollable ancestor inside the Session or its task result slot. It neither
stops propagation nor borrows scroll capacity from a background task container.
Multi-touch, zoom wheel and native text selection retain browser ownership;
hidden or inert Sessions yield to modal owners. Textareas and menus contain
overscroll locally. Code blocks retain vertical chaining to their timeline.
Display popovers follow visual viewport bounds and events independently of the
larger opaque root.

The [design](../../../../docs/design/task-session-protocol.md#session-全屏与任务容器协作)
owns the mechanism and [requirements](../../../../docs/spec/task-sessions.md#session-独立全屏)
own the guarantees. This partially supersedes the geometry and overflow-only
choices in the archived [independent fullscreen decision](../../archived/feature/2026-11-04-session-fullscreen.md).
Its original same-subtree and counted isolation rationale remains applicable.

## Alternatives

**Only extend the white background.** This addresses coverage but leaves root
position and ancestor scroll chaining uncontrolled. Coverage and scroll isolation
must be verified separately.

**Remove visual viewport offsets.** Offsets describe the visible region during
panning and zoom. Removing them without a measured positioning error can move
controls outside that region. Keep them for content layout instead.

**Use a fixed pseudo-element behind a smaller Session.** A desktop probe can
cover the layout viewport this way, but the result depends on fixed containing
blocks and overflow clipping, and creates another hit-testing surface outside
its owner's content rectangle. A full-size opaque root makes the two geometries
explicit and keeps the existing element as the gesture boundary.

**Cancel every touchmove or intercept at the Session root.** Global cancellation
breaks internal scrolling and selection. Early native interception also prevents
React's history and reading handlers from observing boundary intent. A late,
scoped guard preserves those consumers.

**Change all modal body locks to fixed positioning.** Unrelated dialogs do not
need this behavior change. An optional counted position lock contains the new
behavior to Session fullscreen while preserving existing modal ownership.

## Consequences

The shared Session and Bot layouts remain mounted while keyboard-sized viewport
changes preserve opaque coverage. The position lock adds global style ownership
that must remain balanced through nested owners, inactivity and unmount. New
fullscreen geometry must preserve standalone results and any independently
positioned menus. Scrollable code must not receive blanket two-axis containment:
a horizontal-only code area still needs to pass vertical gestures to its parent.

Controlled browser geometry, native desktop wheel movement and synthesized
viewport/touch events provide regression evidence for these mechanisms. They do
not establish the original iPhone's exact cause, keyboard animation, translucent
system accessory rendering or Chinese IME behavior. Device-specific observations
that contradict these assumptions require renewed diagnosis; the application
must not claim real-device verification from emulation.
