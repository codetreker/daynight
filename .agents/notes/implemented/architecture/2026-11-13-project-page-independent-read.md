# Agent Note: Independent Project Page Read

Status: implemented

## Problem

The project page needs its name, repository and management entrances even while
its task graph is loading or unavailable. Deriving these page facts from a task
snapshot makes an unrelated graph failure hide a readable project. Private
project content must still be withdrawn when the identity or project access
changes, including when a response arrives late.

## Decision

The project page reads its Project through the existing Project endpoint,
independently of task synchronization and cache-backed access verification. The
GET authorizes its own resource read, waits for identity admission and orders its
receipt with the access session. Identity and project lifetime fences reject
obsolete responses; a current trusted 404 withdraws project facts and starts
access revalidation. A new Project GET can restore page metadata under unchanged identity and project
fences after withdrawal, even when cleanup or task storage is unavailable; it
does not restore task access or synthesize an access role. During this recovery read and a follow-up to a superseded trusted 404, automatic
task and access checks wait so their repeated observations cannot starve the
Project observation; already dispatched automatic sync cannot publish a competing
access receipt during that check. Its dispatched request has a 60-second deadline;
ordinary background Project reads leave task synchronization running. A
captured cache generation permits fenced withdrawal and cleanup. Without one, a same-account hint causes peer scopes to verify access;
peers isolate their project and direct content during verification,
and restore it only after an identity-bound read or recheck. Generation-bound hints retain the existing cache
and direct-detail withdrawal and revalidation rules. A Project-only peer without
a comparable cache fence or projection temporarily isolates the page and verifies
access independently; confirmed deletion withdraws it immediately. Within one scope, accepted Project, access, deletion
preview, people, task detail and search observations fence older denials
without weakening confirmed write cleanup. Background checks retain displayed facts; read errors
remain recoverable. The task graph's loading and error presentation belongs to the
Overview and Tasks panels, while both continue to share the task snapshot and
its synchronization. The [Web design](../../../../docs/design/daynight-web.md)
owns the current composition and read lifecycle.

This changes the page-fact ownership in the archived [project sections
decision](../../archived/feature/2026-10-25-project-overview-task-sections.md):
the sections still share the task snapshot, but project metadata no longer
requires it. The [member project name decision](../bug-fix/2026-11-06-member-project-name.md)
records the related independent read on the member page.

## Alternatives

**Continue deriving project facts from the task snapshot.** This avoids a
separate Project read but makes the header and management entrances depend on
task synchronization, even when Project access and metadata are available.

**Permanently revoke an inferred generation for an unbound 404.** An older
request can finish after a peer admits a new generation; inferring that the
denial applies to it would erase current access. A fresh peer check distinguishes an independently observed denial while
isolating content during uncertainty.

**Use the project directory as the page source.** The directory is paginated
and filtered; direct entry can address a readable Project absent from the
loaded directory. Making its pages a prerequisite would couple the page to
unrelated navigation state.

## Consequences

The page performs an independent Project read and must handle its own failures
and lifecycle alongside task synchronization. A task graph failure no longer
hides already readable project information. The two existing sections retain
their shared graph, navigation, focus and scroll behavior; neither the
independent read nor project metadata grants access to stale task content. An
unbound hint is in-memory only: if all scopes close before a confirmed
generation is cleaned, it does not persist across processes. A later scope uses
the existing cached preview and online verification rules.
