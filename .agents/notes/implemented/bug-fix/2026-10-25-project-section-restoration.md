# Agent Note: Restore the Project Section

Status: implemented

## Problem

Reloading a project while reading Task list returns to Overview. Returning from
another project also loses the selected section, even though the task category,
filters, expansion and task page position are retained. Restoring those task
preferences behind an unselected section leaves the browsing workspace
incomplete.

## Decision

The selected outer section is a per-project browser preference.
`useProjectSection(projectId)` reuses `useNamedPreference` in
`useProjectViewPreferences.ts` and stores the JSON string `"overview"` or
`"tasks"` under `daynight:project-section:${projectId}`. The decoder rejects every
other value. Initialization reads the record synchronously, so a saved Task list
selection renders directly on reload or return. An absent record selects
Overview. The `ProjectSection` type belongs to the preference module alongside
the inner `TaskView` type.

Read or format failure selects Overview and displays the section-specific
localized notice. Write failure preserves the current in-memory selection and
reports that it was not saved. The shared preference helper retains its existing
error semantics. These failures remain separate from graph request errors and
do not disable section switching.

This partially supersedes the [project section decision](../feature/2026-10-25-project-overview-task-sections.md),
which originally chose mount-local selection to keep Overview as the entry point
without adding a stored format. Its section layout, lazy task workspace retention,
shared synchronization and detail ownership continue to apply. The
[task browsing preference decision](../feature/2026-10-21-task-browsing-preferences.md)
continues to own inner-category, expansion, filter and scroll records; their keys
and formats do not change. Overview scroll remains per-mount memory, and only
active Tasks can read or write the task-category page offsets.

The [Web specification](../../../../docs/spec/daynight-web.md) owns the required
restoration behavior, and the [Web design](../../../../docs/design/daynight-web.md)
owns the component composition. The production-component project fixture uses
the same preference implementation and styles. The static authentication
prototype retains deterministic scenario resets as a visual reference.

## Alternatives

**Keep the section in project component state.** The original choice avoids a
storage record and provides a consistent Overview entry point. It cannot restore
the workspace after reload or project navigation, even when all inner task
preferences are already saved. An independent section record supplies the missing
choice without changing those existing formats.

## Consequences

Reload and project navigation preserve the selected workspace for each project.
The record is local to the browser origin and does not add a server preference,
URL parameter, history entry or data migration. Storage can be denied or contain
invalid data; visible notices preserve the distinction between current-page
interaction and saved preferences. No graph geometry, pan, zoom, detail selection
or fullscreen state becomes persistent.

Restoration tests observe the selected section immediately after remount, real
reload and project return, without clicking Task list first. They also cover
Overview restoration, the absent-record default, project isolation and localized
read, format and write failures. Existing task scroll isolation, retained graph
lifetime and single synchronization ownership remain validation requirements.
