# Agent Note: Omit descriptions from task list JSON

Status: implemented

## Problem

Task inventory can contain long descriptions alongside the fields needed to
identify and select work. JSON list consumers need a compact inventory while
retaining exact versions, timestamps, dependencies and PR references. They also
need an explicit way to read the complete task when its description matters.

## Decision

Every `daynight task list --json` result omits only the `description` property
from each selected task. The default list, `--all`, `--status`, `--ready` and
valid combinations share this output rule. Empty output remains `[]`.

The list renderer projects the complete validated tasks after the command has
finished pagination, status selection and stable grouping. Every remaining API
field retains its name, type and value. Raw PR strings and their order,
dependencies, blocking, timestamps and exact numeric int64 versions survive
unchanged. The projection uses the existing precise JSON serializer and does
not mutate the task resources.

The API DTO, validation and server response retain descriptions. `task show`
and `task ready` JSON retain full task resources, as do the human results from
show, ready, create and update. Human list rendering keeps its existing field
selection. List filters, ordering, complete
pagination, failure handling and final-output timing retain their existing
semantics. A caller needing a listed task's description reads its details.

This partially supersedes the full-resource list JSON choice in the
[original CLI design](../architecture/2026-10-20-project-task-cli-design.md) and
[task-list defaults](../feature/2026-10-22-task-list-defaults.md). Full-resource
JSON originally made every field available without a detail query. That
rationale continues to apply to detail, bounded ready selection and confirmed
writes, while inventory has a narrower field set. The
[requirements](../../../../docs/spec/daynight-project-task.md#pt8-输出分页与错误)
own observable output; the
[design](../../../../docs/design/daynight-project-task.md) owns rendering
responsibilities. The
[installed acceptance decision](../testing/2026-10-20-installed-project-task-acceptance.md)
keeps retained-field equality and real-service behavior observable.

## Alternatives

**Retain descriptions in list JSON.** This preserves the original full-resource
query without individual detail reads, but keeps long problem text in every
inventory response. An operation-specific projection removes that content while
leaving the full resource available to consumers that need it.

## Consequences

JSON inventory has a deliberate field omission that callers must account for;
`--all` changes membership and does not restore descriptions. Reading descriptions
for many listed tasks requires detail requests. Ready selection and detail reads
continue to provide descriptions directly.

The output projection adds no API option, schema change, storage migration or
additional field filtering. Keeping complete DTO validation and the precise JSON
serializer prevents a presentation change from weakening resource validation or
losing version precision. Installed and controlled-response checks compare each
list entry to its full resource after removing only description, so an unintended
loss or rewrite of another field fails validation.
