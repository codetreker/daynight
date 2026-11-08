# Agent Note: Stable Project Header During Access Loading

Status: implemented

## Problem

The project page restores the selected task view's saved document scroll position
when its task graph is ready. Adding project actions later can narrow the title
enough to wrap onto another line, moving content below the heading while leaving
the browser at the old scroll offset. The original trigger was an independent
membership lookup. A cached task-summary preview can now restore the graph before
the live actor access observation arrives, so the same layout boundary remains.

## Decision

The project heading reserves the same action geometry while current access is
unresolved. An inaccessible, hidden placeholder provides localized member and
settings labels and reserves the width of the longer localized administrator
badge. Once access is known, authorized links and the actual role badge replace
the placeholder. The settings link requires confirmed project access.

Current controls consume the [actor access projection](../architecture/2026-11-03-project-access-projection.md).
The first online TaskSync supplies that projection; the member directory retains
its independent profile responsibility. The project-view E2E holds the real
TaskSync response on reload, lets the existing IndexedDB summary preview restore
the selected view, filter and saved scroll, then releases live access. It checks
pending placeholders and verifies that heading geometry and scroll position stay
unchanged when authorized controls appear.

## Alternatives

**Delay scroll restoration until membership lookup finishes.** The original
comparison coupled view readiness to an independent authorization request and
delayed restoring an already available graph. With cached previews, delaying for
live access has the same cost and would also need a restoration path on failure.

**Change the scroll assertion to allow the shifted position.** That would hide a
real document reflow and weaken the per-view scroll-position behavior already
owned by the [project task view decision](../feature/2026-10-22-project-task-views.md).

## Consequences

Access loading preserves the width available to the project title, including
when role labels differ in length. The placeholder stays outside the accessibility
tree and exposes no links before authorization. Responsive wrapping remains with
the existing action group; the regression covers a cached project-view reload at
the width where the original title wrapped.
