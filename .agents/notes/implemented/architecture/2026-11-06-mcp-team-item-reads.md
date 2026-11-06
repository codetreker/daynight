# Agent Note: Bounded MCP Team Item Reads

Status: implemented

## Problem

A legitimate Team, member profile or scoped Project item can exceed a compact
list budget and even the complete-response capacity. Reporting its identifier
alone leaves a standard MCP client unable to retrieve the item or reach later
items. Loading the complete value before slicing would make the read allocation
grow with stored content.

## Decision

The three Team directory tools keep complete normal items and stop at an
explicit oversized-item boundary. The error carries a discoverable
`team_item_read` invocation and a scoped `cursorAfterItem` from that exact item's
ordering position. Reading the item and continuing are separate client actions;
the cursor neither grants authority nor proves delivery.

`team_item_read` returns fixed metadata and nullable field descriptors, then
bounded UTF-8 or base64 byte chunks. It reconstructs the existing list-item
semantics without constructing one complete JSON object on the server. An opaque
revision identifies the exact tuple of existing modification timestamps, at
database precision. Database writes advance each affected timestamp on an actual
visible change. No separate profile revision counter is stored. A changed tuple
rejects continuation so clients discard that item's accumulated content and
inspect its current value again.

The `team_item_fields` table stores one uncompressed EXTERNAL bytea field per
physical row, keyed by kind, object ID and field. Source AFTER triggers maintain
these rows in the source transaction, preserve explicit null field rows and clean
up physically deleted objects. Source BEFORE triggers maintain strictly advancing
modification times. No foreign key is needed for this derived relationship.
Metadata distinguishes an absent field row, which is an integrity error, from a
stored null. The migration backfills existing fields and installs maintenance
atomically within the existing migration transaction. The original text remains
the business value.

Content and its revision share one read snapshot. A separate current-authority
transaction checks credentials, OAuth grant, selected Team membership, target
membership or Project ownership and deletion after waits and before returning
content. It reads bounded facts and does not create business write receipts.

The three directory tools and the new reader return equivalent structured and
serialized-text envelopes, including errors. Their complete CallToolResult is
bounded at 16 KiB by default, or 8 MiB for an explicitly larger chunk request.
Other tools retain their own output strategy. These bounds exclude the SDK's
outer JSON-RPC ID and HTTP batch framing.

The [requirements](../../../../docs/spec/daynight-mcp-team-items.md) and
[design](../../../../docs/design/daynight-mcp-team-items.md) own the complete
tool, field, byte, authorization and storage contracts. The original
[Team adapter decision](2026-11-06-mcp-team-management.md) introduced bounded
directory reads and intentionally stopped at oversized items while no bounded
single-item reader existed. This decision supplies that missing reader and
continuation contract. The [entry decision](2026-11-06-mcp-http-entry.md) continues
to own shared authentication, result envelopes and admission.

## Alternatives

**Increase the list budget or use a complete show result.** A larger legitimate
profile can exceed any fixed response budget. It would also increase default
model output and internal materialization without providing a complete-read
path for the next larger value.

**Skip the item and return an ordinary next cursor.** This would make traversal
appear complete while omitting content. The explicit error instead preserves a
readable identity and distinguishes continuation from having read the item.

**Keep an immutable JSON snapshot.** This permits finishing historical content
despite updates, but adds snapshot generation, storage admission, expiry, cleanup
and recovery. The existing attachment transfer lifecycle is Task-scoped and
would also need broader resource binding. Timestamp conflicts and restarting
the current item satisfy the chosen consistency behavior without that lifetime.

**Store a separate profile content version.** A new counter can identify changes,
but existing modification timestamps serve this purpose once writes guarantee
strict advancement and readers preserve their exact tuple and precision.

**Slice text directly or convert it during every read.** UTF-8 text slicing and
compressed TOAST access can materialize growing prefixes; whole-value conversion
or hashing repeats full work. Write-maintained uncompressed byte projections
move that cost to writes and support bounded range reads.

**Keep binary copies in the source row.** PostgreSQL constructs a tuple before
TOAST storage. A legal 900 MiB source together with an equal-size same-row copy
requires an allocation above the approximately 1 GiB limit. One field per
separate row preserves the source's capacity without combining the source and
copy or multiple copies in one tuple.

**Expose resource links instead of an application read tool.** Standard resource
reads do not supply content pagination. A custom URI/manifest contract would
still be needed alongside another protocol entry, while ordinary tools/call
already provides discoverable bounded actions.

## Consequences

Standard clients can retrieve oversized items and reach later directory entries
without raising default budgets. Successful normal pages retain their complete
item shapes, and clients consuming only TextContent can follow the same loop.
Continuously changing content can require repeated restarts; no historical-read
or frozen-directory guarantee is made.

Separate field rows increase persistent space and write/WAL costs. Uncompressed
copies can be much larger than compressed text. Trigger comparisons, conversion
and migration backfill may load full source fields, so bounded read allocation
does not imply bounded write allocation. The single migration transaction holds
source-table write barriers from before backfill through trigger installation and
commit, requiring a suitable migration window; SQL batching does not provide
incremental commits.

Read, authorization, serialization and concurrent admission remain part of the
same capacity claim. Separate capacity measurements include metadata, early and
late ranges and cancellation, while write and migration measurements account for
their distinct costs. Large stress cases remain outside ordinary CI.
