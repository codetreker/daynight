# Agent Note: Project-bound member page names

Status: implemented

## Problem

The member page used the last project name captured by the task page's member
link. Direct entry had no name, and navigation through another project's
settings reused the previous project's name even though member operations
addressed the new project.

## Decision

The project settings workspace reads its own project name through the existing
project endpoint, inside the authenticated project access boundary. Project and
account keys, cancellation and access revisions prevent revoked or obsolete
responses from restoring a name. The member section does not read or repeat it.
The [section heading decision](../simplification/2026-11-20-member-section-heading.md)
records the presentation change.

Project metadata errors and retries remain independent of member directory and
mutation behavior. The workspace falls back to the project ID until a name is
available.

## Alternatives

**Use the workspace project list.** The list is paginated and filtered, so an
accessible project opened directly may be absent. Loading more navigation pages
would couple the heading to unrelated list state.

**Include the name in project access.** Access currently carries authorization
and ownership without project metadata. Extending that shared wire format would
require broader changes than this display correction.

**Load the name together with members.** A project metadata failure would then
block an otherwise readable member directory. Independent reads keep existing
member operations and their failure handling intact.

## Consequences

The shared workspace reads the project on entry or reactivation. Names
are tied to the authenticated project instead of navigation history. The
existing access refresh and account lifecycle remain responsible for observing
permission and identity changes; this correction does not add another polling
loop or backend endpoint.
