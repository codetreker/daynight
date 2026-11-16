# Agent Note: Local Herdr Native Launch Mapping

Status: implemented

## Problem

Herdr format 3 adds native launch provenance to existing runs. Complete lifecycle
validation couples that conversion to unrelated Session payloads, SQL/JSON
identity agreement and retirement consistency. One unrelated invalid value can
prevent other runs from receiving the required field. The 8 MiB migration limit
also rejects valid history when the added fields grow a previously admitted row,
and the same limit on stored reads can reject a successfully converted result.

## Decision

The lifecycle format owner maps `nativeLaunch` independently in executions and
never-started retirements. It parses only the JSON needed to reach runs and reads
the existing priority inputs: process roles, phase, daemon, stop operation,
admission and segment IDs. Other values pass through without business validation
or relationship repair. Invalid JSON or inaccessible root/runs containers retain
the original string; an inaccessible run retains its own value while other runs
continue. Mapping edits only the target field's source tokens; other tokens,
duplicate keys and original numeric representations remain unchanged. Parsed
JavaScript values determine the field mapping, but never regenerate the complete
row. Rows without a mapped change are not rewritten. SQL identity and
version columns remain untouched. Only JSON syntax errors are skipped at the
parse boundary; real database failures still propagate through the migration
transaction.

Conversion uses no ordinary input or output capacity policy. Existing stored
rows use the same strict JSON decoder without an aggregate byte ceiling, followed
by the existing lifecycle parser and identity/version checks. Runtime field,
list, transition and retirement rules remain unchanged. New writes retain the
8 MiB admission check. No stored codec family, marker, new format version or
recovery mechanism is introduced.

This partially replaces the migration decision in the
[prepared stop-proof note](2026-11-05-herdr-prepared-stop-proof.md). Its native
launch facts, preparation stop proof and runtime process evidence remain intact.
The [lifecycle design](../../../../docs/design/herdr-worker-lifecycle.md#身份与存储)
owns the exact mapping conditions and storage contract.

## Alternatives

**Validate complete records before conversion.** This was chosen with the
preparation stop proof to avoid inventing native evidence, but it blocks required
format work on unrelated historical damage and relationships. Directly carrying
those values preserves them without declaring them healthy.

**Raise the aggregate size threshold.** Another fixed threshold still rejects
valid stored history at that threshold and incorrectly assigns new-write policy
to format conversion and stored reads.

**Parse and serialize complete rows.** JavaScript turns JSON numbers such as
`1e400` into infinity, which serialization replaces with null, and collapses
duplicate keys. That loses unrelated evidence and can hide conflicts from the
strict business reader. Source token edits preserve those original values.

**Introduce a separate permissive stored parser.** The existing strict decoder
already accepts an explicit byte ceiling, and the valid aggregate-size cases
require no change to field or business validation. A second parser would create
another format contract without helping this conversion.

## Consequences

Valid converted records larger than 8 MiB remain readable after reopen and attach;
ordinary new writes remain bounded. Unrelated bad values survive conversion and
can still fail the original business readers. A committed format upgrade proves
the required mappings and DDL completed, not that every stored execution is valid
or safe to recover or stop. Existing SQLite source checks, atomic versioning,
unversioned refusal and actual failure reporting continue to apply.
