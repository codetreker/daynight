# Agent Note: Generic Task Property Commands

Status: implemented

## Problem

Property-specific command options duplicate the server's catalog and force every
new property to acquire argument parsing, pairing, clearing and output behavior.
A client-side JSON parse can also erase duplicate keys or numeric source text
before the authoritative service validates a value. Property removal needs an
explicit operation that preserves the distinction between absent, empty and
null values.

## Decision

The CLI exposes task properties, task set-property and task remove-property.
The [property design](../../../../docs/design/daynight-task-properties.md) owns
the server model; the [client design](../../../../docs/design/daynight-project-task.md)
owns command composition, argument rules and resource output. The
[property-row decision](2026-10-30-task-property-rows.md) remains the owner of
storage, absence and task-wide transactions.

Properties with a task ID reads its current PropertyResource. Properties with
--schema reads the authenticated server-wide definition catalog before project
or Git discovery. The modes are exclusive. Definitions and returned schema
keywords are preserved, not executed as a client validation engine.

Set forwards the original positional value as valueText inside the existing
JSON/version envelope. Only the envelope is encoded; the CLI neither parses the
value nor fetches definitions before writing. The service owns literal name
lookup, JSON/string interpretation, native validation and public writability.
Remove calls the explicit versioned DELETE and receives a PropertyResource
rather than the empty response used for task deletion.

Property names are complete case-sensitive keys. Dots do not select nested
paths. Path encoding preserves representable names exactly; a dot-only segment
that WHATWG URL normalization would retarget is rejected as a transport error
before dispatch. Double-encoding into another name would change the caller's
resource target.

Both writes use the observed task version when supplied. Without it, one
property-resource GET obtains the version before one mutation. Conflicts and
unknown outcomes are not replayed. A default pre-read does not protect an older
decision. Equal sets and absent repeated removals retain the service's no-op
version behavior.

The shared argument definition adds trailing optional positionals and explicit
empty-position permission. Set's value can be empty, and set/remove accept the
existing option terminator for dash-prefixed positionals. Help and Bash/zsh
completion consume those same declarations. Attribute names and values have no
local catalog choices or file fallback.

The original PR interface used repeated URL/title arguments to preserve opaque
paired strings without requiring callers to write JSON. The generic interface
replaces that property-specific syntax with a whole ordered pullRequests JSON
value. Native HTTP create/PATCH retains atomic mixed field/property writes.
Human and JSON output preserve complete property resources; terminal formatting
does not inject defaults or hide deleted keys.

The [task-management skill reference](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/task-management.md#properties)
owns operational property semantics. Its handbook remains a command index;
write-safety owns exact-version and unknown-result rules. Existing managed
human-interaction instructions retain their lifecycle and waiting contract,
with property command names qualified under the task namespace.

## Alternatives

**Parse JSON in the CLI and send a native value.** That could reuse a native
PATCH shape, but parsing and reserialization can remove duplicate-key evidence
and alter numeric input before server validation. The raw valueText contract
keeps one authoritative parser.

**Fetch schema and validate locally.** This adds a round trip, duplicates
validator behavior and can act on a definition that changes before the write.
The definition catalog is on-demand documentation; writes use the server's
current definition.

**Keep per-property flags as aliases.** This would retain command branches and
pairing/clearing semantics alongside generic values. The supported public CLI
has one property mutation contract, while the independent native HTTP atomic
capability remains available.

**Use an unstructured raw request body and a version header.** It avoids an extra
JSON escaping layer, but introduces a second version/transport convention.
The existing JSON envelope makes that cost explicit: its 1 MiB wire limit
includes the version, field names and all escaping.

## Consequences

The service can add a predefined property without changing CLI property
dispatch, storage columns or hardcoded completion choices. Business readers
still validate PR or Worker values where used; generic transport does not
grant public writes to protected claims.

Callers now supply complete JSON values and must account for shell quoting.
Missing, empty arrays and allowed null values remain distinguishable. Prior
property-specific options are rejected, so scripts and installed skill copies
must use the generic commands and their actual help.

The CLI distinguishes local command-shape errors from confirmed service
400 invalid_input failures, including invalid stored values. Database/internal
failures retain 500 internal_error, and no response failure becomes empty
properties or a partial success. Existing cancellation, request identity,
response budgets and uncertain-mutation handling remain in the common transport.
