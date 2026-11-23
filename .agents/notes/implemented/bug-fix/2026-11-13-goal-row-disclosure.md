# Agent Note: Goal Row Disclosure

Status: implemented

## Problem

In the project Goal list, the small arrow was the only disclosure target while
clicking the title opened details. Readers could miss the inline contents or
struggle to expand a Goal without precisely targeting the arrow. Detail and
whole-Goal graph reading still need independent, accessible entrances.

## Decision

The Goal heading provides a broad disclosure target as well as a native
keyboard-accessible disclosure control. The original implementation placed the
arrow, title and static summary inside one native disclosure button, while
independent buttons opened Goal details and the whole-Goal graph. The later
[Goal title details decision](2026-11-14-goal-title-details.md) assigns the
title its own details button and preserves broad pointer disclosure for the
remaining non-interactive heading. Each action retains its own focus restoration.
The completion label stays in the heading, while its keyboard hint uses the
detail button; child actions remain independent of Goal expansion.

The [Goal browsing decision](../feature/2026-11-11-goal-browsing.md) retains
scope projection and nested browsing ownership; the [Goal status background decision](../feature/2026-11-12-goal-status-backgrounds.md)
retains the Goal's own status colors. The [completion time presentation decision](../architecture/2026-11-12-completion-time-presentation.md)
owns the shared hint mechanism. The [Goal specification](../../../../docs/spec/daynight-goals.md)
and [Web design](../../../../docs/design/daynight-web.md) describe the current behavior.

## Alternatives

**Keep the arrow as the only disclosure and let the title open details.** This
preserves the prior separation but leaves the primary inline action with a small
hit target and makes the title behave differently from a chain heading.

**Handle expansion on the row or content container.** Child and sibling actions
would then need event suppression to avoid collapsing the Goal, and a generic
container would not supply native keyboard and disclosure semantics. The later
decision retains the native disclosure button while delegating only
non-interactive pointer targets.

## Consequences

The heading offers a larger disclosure target alongside native keyboard
behavior. The later title decision makes details reachable through either the
title or the independent details button. The completion tooltip stays associated with the independent details button;
focus recovery follows the actual trigger, while collapsing the Goal moves focus
out of hidden content.
