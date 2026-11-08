# Agent Note: Project Task Search

Status: implemented

## Problem

Finding a Task from remembered title or description text must include the whole
project, completed Tasks and real dependency context. Different clients cannot
safely infer matching, ranking or chain membership from their partial caches.
Pagination also needs an explicit answer when the project changes between pages.

## Decision

The server owns literal expression parsing, positive-match evidence and ordered
project search. The parser, evidence calculation and PostgreSQL compiler share a
pure expression data model; the store contract does not depend on search business
operations. A read-only repeatable-read snapshot binds admission, the project
Task fence, matching and dependency context. A cursor binds the query, filters,
identity, fence and last sort key; a changed fence rejects continuation. The
[requirements](../../../../docs/spec/daynight-task-search.md) and
[design](../../../../docs/design/daynight-task-search.md) own the interface and
mechanism.

## Alternatives

**Keep the expression model in the query business package.** This makes the
root DAO contract depend on parsing and evidence operations, reversing the
shared-model dependency.

**Full-text search.** Tokenization cannot preserve arbitrary substrings, such as
one Chinese character or a fragment of a code identifier, under the confirmed
matching rules.

**Search sessions or a project revision write.** Persisted snapshots add lifecycle
and recovery work; a revision row adds a shared write hotspot. The existing
Task epoch, exact count and version sum instead detect changes at each page.

**Graph HTTP response.** Its display limits cannot represent every valid search
context. Search counts its own complete ordinary-edge closure before loading it.

## Consequences

Literal scanning and the fence aggregate cost work proportional to the project;
large closures also require bounded graph processing. Concurrent Task changes
can force a client to restart pagination. The design avoids new indexes,
extensions and synchronization state while retaining a single matching contract.
