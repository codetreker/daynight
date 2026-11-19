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
navigation protects drafts, and source-entry focus restoration returns keyboard
readers to the relationship they followed. Goal completion keeps its existing
mutation owner; a dependency refusal refreshes the independent relationship read.

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

## Consequences

Readers can inspect acceptance blockers without entering a relationship editor.
Each visible description adds one bounded periodic relationship request; it
does not fetch individual targets. Scope and permission events must fence both
retained content and late responses. Cursor history and focus intent remain
runtime reading state, and transient errors remain distinct from empty results.
