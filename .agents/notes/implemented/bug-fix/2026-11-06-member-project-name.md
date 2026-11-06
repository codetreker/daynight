# Agent Note: Project-bound member page names

Status: implemented

## Problem

The member page used the last project name captured by the task page's member
link. Direct entry had no name, and navigation through another project's
settings reused the previous project's name even though member operations
addressed the new project.

## Decision

Each member panel reads its project name through the existing project endpoint,
inside its authenticated project access boundary. The response must identify the
current account. Project and account keys isolate mounted panels; cancellation
and the project access revision prevent revoked or obsolete responses from
restoring a name. Access withdrawal clears the name.

Name reads have their own error and retry state, leaving member directory and
mutation behavior independent. The subtitle reserves space until the name is
available and wraps long names without shrinking the invitation button.

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

Member pages make an additional project read on entry or reactivation. Names
are tied to the authenticated project instead of navigation history. The
existing access refresh and account lifecycle remain responsible for observing
permission and identity changes; this correction does not add another polling
loop or backend endpoint.
