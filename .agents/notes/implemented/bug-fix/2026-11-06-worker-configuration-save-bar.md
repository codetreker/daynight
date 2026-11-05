# Agent Note: Visible Worker Configuration Save Actions

Status: implemented

## Problem

Worker configuration can span several screens. With the save actions only at
its end, editing an early field leaves the overall unsaved state and the save
button outside the viewport. A field-level unsaved marker does not provide a
way to commit or discard the draft.

## Decision

The existing form footer is anchored to the viewport bottom only while the draft
is dirty.
It remains in document order after the fields, with the same status, submit and
discard controls and availability rules. An opaque background separates it from
scrolling fields; a low stacking level leaves dialogs above it. Clean forms use
the original footer position without a persistent overlay. A slot retains the
footer's measured height and supplies its horizontal position and width. A
ResizeObserver follows the slot, footer and workspace so sidebar changes and
text wrapping retain alignment. Scroll and resize handlers update its position.

The document owns scrolling. The editor checks the focused field against the
measured footer on focus, draft edits and viewport/footer size changes, scrolling
only when the field would be obscured. It includes field errors when the whole
field fits; a taller field prioritizes the active control. Focus and selection
stay on their existing nodes. Background configuration observations do not
trigger this scrolling, and inactive configuration tabs detach the listeners.

The [Web design](../../../../docs/design/daynight-web.md#worker-云端配置编辑)
owns the editor behavior. Saving, conflicts, uncertain-result reconciliation and
background application observations retain their existing owners.

## Alternatives

**Keep the actions at the end of the document.** Long project lists separate the
first edit from the only save operation by several screens.

**Use a bottom-sticky form footer.** The form follows save notifications. On a
short viewport, conflict and error notices can push the entire form below the
viewport, constraining its sticky footer below the visible area as well. A fixed
footer with a measured slot preserves notification and summary layout.

**Duplicate the actions in a page overlay.** This would add a second focus and
submit surface. Positioning the existing footer preserves one action set and
the original keyboard order.

**Only add scroll padding to the form.** The form is not the scroll container,
so that padding would not keep focused fields above the footer. CSS margins
alone would also not reveal an already-focused field when its first edit
activates the overlay.

## Consequences

Dirty forms retain visible save actions while the user scrolls through their
fields. Geometry checks add layout reads on editor interactions and size
changes, but do not change resource requests or draft persistence. Browser
regression tests exercise actual application routes at phone and desktop sizes,
including keyboard focus and save outcomes, with controlled API responses.
The dirty footer remains visible when scrolling past the form to its summary.
The Worker page ancestors must not introduce a transformed containing block for
the fixed footer without revisiting its positioning.
Those checks do not establish physical-device soft-keyboard behavior or actual
Worker application of saved settings.
