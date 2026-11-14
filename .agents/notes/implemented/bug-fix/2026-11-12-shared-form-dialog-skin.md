# Agent Note: Shared Form Dialog Skin

Status: implemented

## Problem

The shared Task and Goal forms use dialog sections without the scoped skin of
the existing authentication dialogs. Their controls and spacing therefore
fall back to browser defaults, and long or short-viewport content can make
the form difficult to use.

## Decision

The shared `FormDialog` owns its visual boundary in `task-organization.css`.
Its shell and form can shrink, body sections scroll, and the header and footer
remain available. The account refresh notice occupies a separate header row;
Text fields receive scoped styling and focus indication, selection fields use
the [shared native control](../architecture/2026-11-14-shared-native-select.md),
and common buttons keep their application styles. The existing overlay and mutation owners remain
responsible for focus, drafts and writes. The [Goal requirements](../../../../docs/spec/daynight-goals.md)
describe the visible contract.

## Alternatives

**Add the authentication dialog class.** This couples the shared forms to an
authentication-specific namespace and does not provide their field or mixed
content layout.

**Replace dialogs with a new application-wide component.** This would expand
the change to unrelated authentication, management and detail flows without
being necessary to repair the shared form.

## Consequences

The project Task creation and Goal creation forms share the same bounded
presentation without changing their business operations. The skin originally
also served Goal detail Task creation and add-existing forms; the [Goal Task
entrance decision](../simplification/2026-11-12-goal-task-entrances.md) removed
those entrances. The scoped skin must be maintained alongside the other dialog
skins when the product's visual language changes.
