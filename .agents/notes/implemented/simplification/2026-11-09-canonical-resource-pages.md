# Agent Note: Canonical Resource Pages

Status: implemented

## Problem

Project, Team, member, invitation and attachment readers repeated admission of
stored fields and response bytes after write ingress had already established
the canonical representation. Page callbacks queried one candidate at a time,
while protocol adapters repeatedly encoded a growing prefix to choose the page.
Optional reader detection and fallback paths also left the same use case with
multiple read contracts. Generic MCP output validation and byte admission could
then reject a complete count-based read after the domain operation succeeded.

The original [encoded response decision](../architecture/2026-11-07-encoded-response-budgets.md)
included arbitrary historical values in its read model and tried to bound their
encoded materialization. Its write response admission and completion facts remain
useful independently of that read policy. The
[Worker/Bot](2026-11-09-worker-bot-canonical-reads.md) and
[Task batch-read](2026-11-09-task-canonical-batch-reads.md) decisions establish
canonical reads for those domains; ordinary resource pages use the same boundary.

## Decision

Write ingress owns structure, fields, normalization, existing capacity rules
and transaction-state conditions. Stored reads use the existing ordinary reader
methods and natural decoding or serialization without repeated Validate,
Normalize, Admit, field limits or byte budgets. No historical compatibility,
scan or migration is added, and removed read budgets do not become write quotas.

The [Task Session work overview](../feature/2026-11-10-task-session-observation.md)
is a scoped exception: its independent summary pages retain a dedicated 256 KiB
complete-response budget and resumable group/target prefixes. Ordinary Task
list, show and graph remain complete. This exception does not restore shared
MCP runtime output validation or generic read admission.

Project, Team, member, invitation and attachment page operations select their
requested count plus one lookahead in a batch, after current authorization and
scope filtering. The next cursor follows the last returned item. Existing
scope, sort order, request and cursor validation, explicit versions and parent
visibility remain. Complete unpaged directories keep their full shape and
completeness. Read-admission wrappers, optional capability fallbacks, per-item
candidate loops, byte trimming and repeated prefix encoding are absent.

MCP read tools keep advertised result representations and ordinary JSON
encoding. The shared wrapper does not perform runtime output-schema validation
or 128 MiB result admission for successful reads. Input schemas, request body limits,
credential checks, concurrency permits and deadlines remain. Write and upload
tools retain output validation and response admission; actual write completion
facts remain independent of delivery. Encoding,
query, cancellation and I/O errors preserve their causes.

Attachment reads retain authorization and safe path resolution, immutable
transfer identity, requested ranges and actual I/O ownership. These input and
file-lifecycle rules are separate from admitting already stored metadata or
encoded read responses. Upload limits and publication/transaction outcomes
remain write responsibilities. The [MIME write decision](../feature/2026-11-06-attachment-mime-byte-limit.md)
retains its original limit and historical rationale without imposing read admission.

The [server design](../../../../docs/design/daynight-server.md),
[authentication design](../../../../docs/design/daynight-auth.md) and
[attachment design](../../../../docs/design/daynight-task-attachments.md) own
ordinary resource reads. The [MCP entry decision](../architecture/2026-11-06-mcp-http-entry.md)
owns authentication, input and permit lifetimes. This supersedes the remaining
read-admission portion of the encoded response decision; its write checks and
completion guarantees remain. Earlier canonical-read decisions retain their
domain mechanisms and point here for the shared MCP entry and other lists.

Thread server reads retain complete count-selected pages without per-message
or page-byte admission. CLI prints the complete selected page and uses the
server direction flags without local prefix trimming. Web preserves visible,
incoming and reference windows of 200, 100 and 16 message identities, with one
send reservation, reading anchor and latest receipt ownership. Their byte
accounting and reservation guards are absent; complete body reads and retained
messages use the same count windows. Thread body input and full encoded-message
write admission remain 64 KiB. CLI uses its shared operation transport defaults,
and Web retains authenticated streaming, fatal UTF-8, its deadline and the
independent error-envelope transport limit. The
[CLI](../../../../docs/design/task-thread-cli.md) and
[Web](../../../../docs/design/task-thread-web.md) designs own current behavior.
The archived [CLI decision](../../archived/architecture/2026-11-03-task-thread-cli.md)
preserves the original per-message and terminal-package capacity proof, and the
[Web decision](../../archived/architecture/2026-11-03-task-thread-web.md) retains
the former byte-window rationale; those read guards are superseded.

Client transport policies remain independent. Worker Bot reads retain 64 MiB for
both one response and a complete operation; CLI Bot list retains 256 MiB for both,
while other commands keep their existing defaults. Client cache and transport
failures do not become server read quotas or imply that a partial list is complete.

## Alternatives

**Keep byte admission while making accounting linear.** This would remove
repeated prefix encoding but retain read refusal, field revalidation and another
page-building contract. It would not implement the chosen write/read boundary.

**Keep optional admission and fallback readers.** Callers would still depend on
runtime capability checks and two competing pagination paths. The existing
ordinary interfaces already express authorization, count and cursor semantics.

**Reverse the original response change wholesale.** A full reversal would also
remove write admission and completion-fact fixes. Selective removal preserves
those current guarantees and the previously delivered canonical read mechanisms.

## Consequences

Ordinary page reads use one candidate batch and preserve count continuation.
Complete directories and MCP results can grow with the actual stored data;
server reads no longer promise an encoded-byte bound or validation of historical
contents. Runtime output work remains proportional to complete results, and
ordinary JSON encoding can still fail naturally.

Tests retain complete fields, current scope and authorization, sort order,
count cursors, explicit versions and original I/O ownership. Thread consumer
tests read complete large-message pages and advance real boundaries without
byte clipping, while malformed later items prevent partial publication. Write limits and
atomic completion remain independently verified. Query-count and encoding-work
comparisons require matching normal fixtures and settings; passing correctness
checks alone does not establish hosted request or CI speed.
