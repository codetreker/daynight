# Agent Note: Task Detail Control Font

Status: implemented

## Problem

The ordinary Task detail state row presents status, assignee and platform values
at a larger size than the surrounding compact metadata. These controls are also
used elsewhere, where changing their presentation would affect unrelated views.

## Decision

The ordinary Task detail state controls select `xs` for the status trigger,
assignee label and selected identity. The platform selector explicitly selects
`xs` through the shared selection presentation. The shared `textSize` choice is
independent of density and defaults to `sm`; native selects inherit it from their
host, and existing touch rules retain precedence. The status and assignee group can wrap when enlarged text and a former-member
marker cannot fit together. Menus and Goal detail retain their own typography. The [component design](../../../../docs/design/native-select.md)
owns the shared contract; the [shared selection decision](../architecture/2026-11-16-shared-selection-presentation.md)
owns its presentation boundary.

## Alternatives

**Override the native select locally.** This would bypass the shared owner of
selection typography and risk diverging from its native and touch rules.

**Tie the size to compact density.** Other compact consumers would change even
when their existing typography is appropriate.

## Consequences

The three controls share a scalable size in all ordinary detail surfaces without
changing their interaction or other consumers. The shared presentation API gains
an explicit choice that callers must opt into; its touch modes still control
font and target size when applicable.
