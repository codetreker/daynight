# Agent Note: Versioned Terminal Session Contracts

Status: implemented

## Problem

The Web Session schema represents native messages, turns and interactions. A
sampled terminal screen cannot supply those semantics, while terminal execution
still needs the same task ownership, navigation and immutable archive identity.
Extending strict v1 objects with terminal fields would break older readers.
Independent Worker, service and browser representations would also make input
fencing and archive integrity dependent on incompatible assumptions.

## Decision

The browser-safe TypeScript v2 modules and independent Go v2 package define
strict, explicitly selected messages and a terminal recording archive. A common
envelope preserves Session and claim ownership; its content discriminator keeps
terminal snapshots separate from an unchanged v1 native snapshot adapter. Raw
byte decoders reject duplicate keys and invalid Unicode before object parsing
can discard evidence. Both implementations consume the same wire fixtures.

Terminal frames are independent full screens with a restricted text-style model.
The archive embeds original frame JSON text with its byte hash and uses explicit
segment and frame ordering. Generation ledgers retain original run ownership and
stop-proof references. Finalization records bind all stopped generations before
the service can freeze the Session; validators do not substitute for that lock
or for trustworthy native stop observations.

The [preparation stop decision](../../implemented/bug-fix/2026-11-05-herdr-prepared-stop-proof.md)
adds an explicit proof for a generation whose native launch was never submitted.
Ordinary proofs keep their original shell and agent requirements and JSON shape;
the added branch requires coordinated reader support and cannot grant recovery.

Ready receipts bind actual archive bytes. Unavailable receipts require explicit
zero-content evidence and a distinct disposition digest; missing registered
content remains corruption. Canonical serialization provides portable receipt
digests and budgets, while content hashes always cover original bytes.

The [v2 specification](../../../../docs/spec/session-v2.md) owns behavior and
limits; the [contract design](../../../../docs/design/session-v2-contract.md)
owns fields, producer responsibilities and algorithms. This extends the
[file archive decision](2026-10-30-session-file-archives.md) without rewriting v1
files or weakening their completeness requirements. It extends the
[claim-frozen mode decision](2026-10-27-task-session-mode-contract.md) with a
terminal content contract while preserving native runtime ownership.

## Alternatives

**Add terminal variants directly to v1.** Existing strict parsers reject added
fields and variants. Relaxing those parsers would obscure whether a consumer
understands terminal input and partial-recording semantics.

**Treat terminal screens as native timeline messages.** This would invent message,
turn and acknowledgement identities that Herdr does not provide and would make
transport completion appear to prove provider acceptance.

**Hash a reserialized frame object.** This simplifies embedded values but lets
language-specific escaping change the identity of preserved source bytes. The
archive keeps original frame text and checks its exact hash instead.

**Use the existing v1 schema helpers for every v2 value.** Their optional-field
and Test Session compatibility rules, and their general array limit, belong to
v1. Independent validators prevent those rules from silently widening v2 or
rejecting valid large frame inventories.

## Consequences

Downstream implementations share concrete fields, limits and failure examples
without changing v1 producers. The service and Worker must still enforce durable
ownership, monotonic leases, operation idempotency, finalization exclusion and
native stop evidence. Valid JSON alone proves none of those runtime facts.

Embedding frame JSON as text costs escaping space; the 60 MiB recording budget
counts that representation rather than assuming raw terminal bytes. Archive
hashing and validation require bounded whole-package memory. Streaming chunks,
compression, remote live backup and automatic source GC remain outside this
format; adding them requires explicit version and retention decisions. The
current version, content kind, segment identities and completeness fields keep
future readers from having to reinterpret existing history.

The protocol modules do not enable Herdr routes, input or playback. Runtime
capabilities may be advertised only after their implementations and native
validation exist. Contract tests preserve interoperability, not native execution
or end-to-end availability claims.

The [terminal server decision](2026-11-03-terminal-session-server.md) defines
shared registry dispatch, trusted recording responsibility and correlated control
ACKs while retaining these strict v1/v2 decoding rules.
