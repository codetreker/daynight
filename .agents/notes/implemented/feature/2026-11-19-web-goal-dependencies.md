# Agent Note: Read-only Goal Acceptance Dependencies

Status: implemented

## Problem

Goal readers need to see acceptance prerequisites and downstream consumers,
including cross-project relationships and inaccessible prerequisites. Target
status and access can change without advancing the source Goal's Task version,
so ordinary detail synchronization cannot establish current dependency facts.

## Decision

The Goal description's information aside starts with an independent read-only
relationship section. It consumes the dedicated GET projection and its
completionBlocked value. Hidden targets retain no client identity or status;
downstream readers use bounded cursor pages. The [relationship design](../../../../docs/design/goal-dependencies.md#web-只读关系)
owns request admission, permission withdrawal, legacy-route handling and navigation.

Relationship data lives in memory under the current identity and resource
qualification. Visible description polling follows the existing Task observation
cadence. Principal and permission fences apply before publication. Background
refresh failures retain still-admitted content; trusted access changes withdraw
it and invalidate outstanding responses. A router-level JSON 404 without a
principal means unavailable capability while leaving the source Goal readable.

Links use each endpoint's actual Project and Goal. Ordinary application
navigation protects drafts. A relation pointing to the underlying standalone
root atomically pushes its URL and empty nested-reader selection through the
same draft admission, so same-URL navigation reveals the root while Back keeps
the original dialog. Source-entry restoration keeps only the source
resource/history, current cursor, previous cursor trail and originating link
under the account scope, separately for each browser entry and Goal reader.
Admitted reads update the current entry position. New tab entries inherit only
current coordinates, while known entries reread their saved cursor even without
a component remount. Focus consumption leaves coordinates and the originating
destination available for repeated native Forward/Back traversals; a matching
committed departure rearms focus. A canceled link followed by unrelated navigation
clears its focus candidate. Fresh authorization precedes returned link focus. Transient return failures retain the
coordinates and focus intent for retry; an authorized page without the link
falls back to the Goal heading. Source permission/history withdrawal invalidates
the saved position, including while its Goal component is unmounted. Goal
completion keeps its existing mutation owner; a dependency refusal refreshes
the independent relationship read.

## Alternatives

**Refresh relationships only when Task detail changes.** Relationships and target
status have independent revisions, so this would leave completion feedback stale.

**Extend the existing Task DTO and cache.** That would couple separately
redacted, independently paginated relationships to legacy Task parsing and
persistent summary ownership. The dedicated REST resource already supplies the
necessary projection without changing those contracts.

**Route through ordinary external Task navigation.** Its Parent and chain
semantics do not identify cross-project Goal resources. Exact resource links
preserve the intended destination and native browser actions.

**Retain relationship rows across route changes.** That would require a live
permission and history owner for each saved page while its reader is unmounted.
Cursor-only restoration preserves the reading position while requiring a fresh
authorized projection for every returned page.

## Consequences

Readers can inspect acceptance blockers without entering a relationship editor.
Each visible description adds one bounded periodic relationship request; it
does not fetch individual targets. Scope and permission events must fence both
retained content and late responses. Cursor history and focus intent remain
runtime reading state under the account scope. Coordinates survive completed
returns and track subsequent paging; focus is consumed once per matching return.
Source access/history invalidation retires both, including while unmounted. They do not preserve relation rows across a route
remount. Transient errors remain distinct from empty results.
