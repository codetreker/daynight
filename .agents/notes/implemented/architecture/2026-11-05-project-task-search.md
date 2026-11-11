# Agent Note: Project Task Search

Status: implemented

## Problem

Finding a Task from its ID or remembered title or description text must include the whole
project, completed Tasks and their resource context. Different clients cannot
safely infer matching, ranking or membership from their partial caches.
Pagination also needs an explicit answer when the project changes between pages.

## Decision

The server owns literal expression parsing, positive-match evidence and ordered
project search. ID, title and description share expression evaluation; only a
positive exact full ID match in a successful branch precedes title ranking.
The parser, evidence calculation and PostgreSQL compiler share a
pure expression data model; the store contract does not depend on search business
operations. A read-only repeatable-read snapshot binds authorization, the project
Task fence, matching and parent Goal context. Distinct parent titles are read
in one batch and Go selects description snippets. The [typed resource read decision](2026-11-11-typed-task-resource-reads.md)
replaces the originally selected ordinary-component context with actual membership.
The [canonical batch-read decision](../simplification/2026-11-09-task-canonical-batch-reads.md)
removes stored graph-size and response-byte admission while keeping exact-ID
ranking, positive evidence and the existing search deadline. A cursor binds the query, filters,
identity, fence and last sort key; a changed fence rejects continuation. The
[requirements](../../../../docs/spec/daynight-task-search.md) and
[design](../../../../docs/design/daynight-task-search.md) own the interface and
mechanism.

## Alternatives

**Keep the expression model in the query business package.** This makes the
root DAO contract depend on parsing and evidence operations, reversing the
shared-model dependency.

**Separate ID lookup and merge.** Cross-field Boolean expressions, positive
evidence and pagination still require a unified evaluation and ordering.

**Field registration framework.** Three fixed fields do not justify another
registration and projection mechanism.

**Full-text search.** Tokenization cannot preserve arbitrary substrings, such as
one Chinese character or a fragment of a code identifier, under the confirmed
matching rules.

**Search sessions or a project revision write.** Persisted snapshots add lifecycle
and recovery work; a revision row adds a shared write hotspot. The existing
Task epoch, exact count and version sum instead detect changes at each page.

**Graph HTTP response at the original decision.** Its display limits could not
represent every valid search context. Search therefore counted its own complete
ordinary-edge closure before loading it. The later canonical-read decision
removes both read-capacity checks while preserving the distinct selection rules.

## Consequences

Literal scanning and the fence aggregate cost work proportional to the project. Concurrent Task changes
can force a client to restart pagination. The design avoids new indexes,
extensions and synchronization state while retaining a single matching contract.
