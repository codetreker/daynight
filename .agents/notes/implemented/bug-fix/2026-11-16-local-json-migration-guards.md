# Agent Note: Guard local Worker and Web JSON migrations

Status: implemented

## Problem

Worker 9→10 and Web 1→2 use SQLite JSON functions on retained records. A malformed
value or an inaccessible container can abort the entire format transaction even
when other rows can be mapped. Rewriting an unchanged invalid value also violates
the table's JSON check. The existing migration field mappings do not require a
complete business record or reconciliation of its relationships.

## Decision

The existing SQL steps reject embedded NUL before calling SQLite JSON functions,
which otherwise may accept a truncated prefix. They guard JSON operations with
nested CASE expressions and
update only rows whose applicable mapping changes the value. Worker maps the
accessible registration value and the original execution recovery fields in each
row; Web removes only its original cleanup paths. Unmappable or unchanged values
retain their original strings. The [migration design](../../../../docs/design/cli-sqlite-migrations.md)
owns their current semantics and transaction boundary.

## Alternatives

**Full record validation or repair.** This would make format conversion depend on
business health and could alter unrelated execution or blocker relationships.

**Rely on a WHERE or AND evaluation order.** SQL expression evaluation order
is not a safe guard for JSON functions on malformed input. Returning the original
value from an unconditional UPDATE would still invoke the JSON constraint.

## Consequences

Independent rows can migrate despite locally unmappable values, without a new
format version or runtime recovery branch. Existing readers may still reject a
retained bad value. Actual SQLite failures remain transaction failures, and the
format change does not establish business consistency. This narrows the Web
migration's behavior recorded in the [original format decision](../../archived/architecture/2026-10-30-cli-sqlite-migrations.md).
