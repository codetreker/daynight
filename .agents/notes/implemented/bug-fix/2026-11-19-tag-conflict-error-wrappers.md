# Agent Note: Preserve tag conflicts through transaction error wrappers

Status: implemented

## Problem

Duplicate tag names were reported as HTTP 500 even after a confirmed rollback.
The REST classifier counted database error wrappers as independent failures.
The PostgreSQL project transaction adds an outer store error around the
transaction error and the DAO's marked unique-index violation, so the real
production path contained two wrappers. The Web consequently treated an ordinary
name collision as an unknown write outcome and prevented direct draft correction.

## Decision

The [REST classifier](../../../../packages/daynight-server/internal/server/tag/routes.go)
distinguishes store errors enclosing the name-conflict marker from the single
database error in its marked branch. Enclosing wrappers must still report
database failure with SQLSTATE 23505. Every joined branch is checked: only the
DAO's exact marker-plus-store-error pair is accepted. Exactly one marker, one
database error below it, and one reliable operation-phase rollback are required.
Cleanup failure, a commit attempt, additional error branches, and unknown or
committed outcomes retain their existing failure responses.

Regression coverage at the [REST boundary](../../../../packages/daynight-server/internal/server/tag/)
must execute the real project transaction, tag service and HTTP adapter with
fixed authentication, verifying duplicate creation and rename refusal together
with unchanged persisted catalog state. Controlled error tests own the unsafe
completion and additional-failure cases.

## Alternatives

**Allow any number of database errors.** A count relaxation alone would accept
additional failures in the marked branch. Classification instead retains the
single marked database error and validates all enclosing summaries and branches.

**Remove the project transaction's outer error wrapper.** That would change
shared database diagnostics for unrelated project operations. The defect belongs
to the tag-specific interpretation of the existing error chain.

## Consequences

Reliable duplicate-name refusals return the existing 409 `tag_name_conflict`
response, allowing the Web to preserve and correct the draft. No frontend state
machine or shared transaction contract changes. The classifier remains coupled
to the DAO's explicit marker structure; changes to that structure require
reconsidering both the classifier and its production-path regression.
