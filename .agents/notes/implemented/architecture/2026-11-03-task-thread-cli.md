# Agent Note: Readable bounded task discussion commands

Status: implemented

## Problem

Task participants need explicit CLI discussion reads and posts whose complete
identities, replies and bodies remain understandable. HTTP byte bounds alone
do not bound terminal text after escaping. Untrusted text can imitate fields or
terminal controls, and a lost POST response cannot establish whether a message
was committed. Client parsing and post-processing must preserve these facts.

## Decision

The CLI owns thin Thread decoding and readable rendering, consuming the
[service contract](../../../../docs/spec/daynight-task-thread.md) independently
of the browser. CLI source-scanning primitives preserve raw JSON resource
spans and reject duplicate members before object decoding. Every read item
retains the service's 64 KiB resource bound; complete pages retain its 256 KiB
bound. Measurement uses actual Go-encoded source bytes, including HTML escapes,
not a different client serialization.

Read fetches one page with an explicit default count of 20. The renderer shows
full IDs and labeled fields, with more-before above and more-after below. Body
encoding preserves LF/TAB and literal escapes while making unsafe controls
visible. A 256 KiB text budget selects a contiguous directional subset of whole
messages. DEL uses four-byte `\x7f`; fixed wire and rendering fixtures enforce
the 183/473-byte bound that makes every admitted message fit independently.
Only fully consumed read pages advance continuity; post receipts cannot skip
other participants' unseen messages.

A successful response admits a canonical account header; POST author identity
must match it. Origin and PAT are captured once per invocation. Strictly
validated 201 confirms a message before receipt output and cleanup, retaining
its identity through later local failures. Dispatched uncertain POSTs remain
unknown and are never replayed. A verified clock refusal is definite failure;
generic server errors cannot establish rollback.

Thread diagnostics retain causes internally but expose controlled text. Grammar
errors are identified from actual selected command definitions, preserving
exit status 2 without printing raw arguments. Resource or lifecycle failures
exit 1 without leaking message text or untrusted service diagnostics.

## Alternatives

**Print API JSON or compressed aliases.** This would expose a program resource
rather than the required readable author, reply and body presentation. Full
labels and identities preserve direct use of message IDs for continuation.

**Use the shared task-list pagination loop.** That loop consumes all pages and
uses a different cursor resource. Thread requires one bounded request and
explicit before/after message IDs, so it has its own page decoder and renderer.

**Count JSON bytes as rendered bytes.** Visible control escapes and indentation
can expand output, especially DEL and C1. A separate exact text budget and an
implementation-enforced expansion proof prevent truncation of legal messages.

**Share a Thread feature module through one client.** This couples independent
browser and CLI delivery. Pure source primitives can be reused without moving
client-owned validation or creating a feature dependency between clients.

**Retry uncertain posts or reconcile equal bodies.** Both can append duplicate
messages or mistake another message for the failed request. The service has no
independent submission identity; normal reads inform a new explicit decision.

## Consequences

Readable output remains bounded without hiding authors or cutting bodies.
Clients make explicit continuation decisions and retain their own read position.
Canonical response identity checks add no current-user request, and explicit
project selection avoids unrelated resource preflight calls.

The text proof constrains future wrapper and label growth. Source-parser,
service-parity and rendering tests must evolve together when fields or encoding
change. Stronger submission identity, mutable messages or automatic dispatch
would require new requirements and API contracts; no dormant mechanisms are
included for those capabilities.

The [CLI design](../../../../docs/design/task-thread-cli.md) owns the complete
mechanism. The [storage decision](2026-11-03-task-thread-storage.md) remains the
owner of database ordering, snapshots and commit semantics.
