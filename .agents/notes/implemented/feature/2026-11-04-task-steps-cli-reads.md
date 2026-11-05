# Agent Note: Read Task Steps from the CLI

Status: implemented

## Problem

Task-owned ordered records need a command-line read path that returns the same
complete collection and stable short identities as the service. Ordinary Task
projections do not contain Steps, and Task's three-state parser cannot represent
the fourth Step state. A malformed or mismatched response must not be presented
as an empty collection or lose precision when its parent version exceeds the
safe JavaScript integer range. Installed command help and the standalone manual
must describe the commands the package actually provides.

## Decision

The [resource contract](../../../../docs/spec/daynight-task-steps.md#cli-读取)
provides `task step list` and `task step show` reads. Their lightweight command
definitions feed help and Bash/zsh completion, and task dispatch selects their
focused handler before ordinary Task operations. Help and local ID validation
complete before loading server configuration, Git discovery or network code.
Canonical Step arguments are full eight-hex values within a Task, with
case-insensitive input and lowercase output.

Typed reads reuse the existing server operation, authentication, cancellation,
request/operation deadlines, response-byte budgets and exact bigint JSON codec.
The 64 MiB endpoint body cap is inclusive and combined with the configured
response budget using the smaller bound; total operation bytes remain charged
and stricter limits and shared defaults remain intact.
An explicit project selects the Steps path directly; it does not add project or
parent GETs or fall back from a child 404. Normal repository project discovery
runs only when the project is omitted. Its complete zero/multiple-match results
are represented by the pure repository-owned `ProjectDiscoveryError`: missing or
ambiguous kind plus copied, frozen canonical project IDs in their original order.
The producer validates distinct canonical IDs and the non-unique match count; it
retains no project object, name, repository URL, working directory or credential.
The type's normal message preserves the existing project-selection contract.

Step diagnostics recognize that type directly or through cause/AggregateError
wrapping and format its verified kind and ID facts. Missing matches retain
`Project does not exist.`; ambiguity lists every candidate and directs explicit
`--project <id>` selection. No candidate becomes the current project context.
This expected failure text is separate from arbitrary prepare-error messages:
text similarity grants no public-output authority, and configuration, Git,
network and cleanup causes remain chained internally. Resolution request order,
binding policy and explicit-project behavior remain with their existing owners.

Each read validates the complete returned
resource and requested scope, including unique canonical short IDs, all Step
fields, four-state values, original text and UTC microsecond time strings. Array
order and time spelling remain unchanged; no missing value is filled or broken
record skipped.

List text shows the Task, exact parent version and count, followed by saved-order
one-based numbers, complete short IDs, status and full titles. Show includes every
target field and the complete Markdown description. Both use the existing safe
terminal escaping and additionally expose bidi controls as visible escapes. JSON emits one full collection or item resource with raw
strings and exact int64 numbers, followed by LF. The complete result is decoded,
validated and rendered before the byte-output channel receives it; failures use stderr and the
existing 0/1/2 exit meanings. A 401 supplies login guidance without authentication
or request replay.

The [standalone manual](../../../../packages/daynight/src/commands/skill/usage.md)
contains only the delivered Step read commands and retains its self-contained
frontmatter and content. Its copied build/package bytes remain separate from the
canonical `using-daynight` workflow resources. The
[manual decision](2026-11-03-cli-skill-reading.md) owns that output and packaging
mechanism; Step orchestration guidance does not move into this read integration.

## Alternatives

**Expose Steps through ordinary Task reads or reuse the Task status parser.**
That changes existing projections and conflates Task's three states with the
independent four-state record. Dedicated read DTOs and commands preserve each
resource's ownership and keep full Steps out of Task lists and synchronization.

**Print the raw response or accept partially decoded items.** Scope mismatch,
duplicate or noncanonical IDs and malformed fields would then become apparent
success. Whole-resource validation provides one complete result and keeps read
failure distinct from a legitimate empty collection.

**Convert versions or timestamps through JavaScript numeric/date defaults.**
Floating-point versions lose int64 digits; timestamp reserialization can round
or normalize the stored spelling. Bigint JSON and validated original strings
preserve the actual resource facts.

**Expose every prepare failure or parse discovery message prefixes.** Prepare
errors can contain configuration, Git stderr, URLs or cleanup details, while
ordinary text does not prove a trusted discovery result. A typed producer owns
the verified match facts; Step diagnostics format those facts without promoting
arbitrary cause messages or depending on message spelling.

## Consequences

Installed list/show use the same parent version and ordered content as the
service, including empty collections and single-item full descriptions. Their
local syntax and help stay independent from configuration and network access,
while explicit project reads also work outside Git. Only delivered reads appear
in help, completion and the standalone manual.

Full validation, rendering and output buffering remain linear in the response
size and use the shared operation budgets. Byte output shares cancellation and
can leave partial stdout on an output failure, which remains a nonzero result. Unit and installed-package behavior
checks cover valid resources, malformed/scope failures, exact versions, safe
output, project selection and help isolation. Discovery checks cover zero and
multiple matches, complete candidate IDs and explicit-selection guidance, typed
cause wrapping and arbitrary-message privacy through the same command path.
Real-server/PostgreSQL cases use
the receipt-verified installed Node entry, while the packed CLI acceptance runner
uses its existing cross-spawn owner for literal daynight/dn launchers on native
platforms. These are complementary checks with separate owners. Manual resource copying, frontmatter and byte-comparison checks establish
packaging fidelity; they do not prove
runtime parser semantics, model understanding or workflow compliance. No Step
mutation command, automatic retry or new execution mode is introduced.
