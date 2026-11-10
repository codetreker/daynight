# Agent Note: Task Session History Reads

Status: implemented

## Problem

Task Session observations identify the execution and its live state, but command
clients also need recent original entries and earlier context. Browser display
projection deliberately replaces oversized entries, so it cannot establish that
the original body was read. A completed execution must remain readable from its
archive without switching to a newer claim or downloading the whole archive to
the client.

## Decision

Task Session history uses shared domain and service operations behind HTTP, MCP
and CLI adapters. Explicit Session identity is preserved across every read. The
Controller exposes raw journal entries through negotiated content requests;
existing browser timeline projection remains separate. Content-read capability
belongs to each successful connection fence, and absence on reconnect clears it.

History pages have a dedicated 256 KiB complete-response budget, including the
transport envelope. Oversized entries become bounded metadata and a content
reference, while the page cursor still advances. Entry reads return at most
32 KiB of UTF-8 canonical JSON per call. Epoch, source, revision, digest and total
bytes prevent mixed-version assembly. Filtering applies only to the selected
page. Archive cursors bind the immutable digest; live and archive cursors cannot
be combined.

Coverage comes from the original entries and resources, before page selection,
body references or conversation filtering. Otherwise a truncated tool output
could disappear from a filtered page while the client reports a complete read.
Budget references preserve retrievable bodies and do not themselves imply a
coverage gap.

MCP history calls use independent requests or a single-call legacy batch.
Multi-call batches containing history are rejected before execution because
other results could exceed the complete response budget. A dedicated bounded
buffer commits the complete response only after encoding, including errors;
oversized IDs are refused before dispatch. Ordinary read tools keep their
existing encoding and admission behavior.

Archive readers retain the existing preflight, owner and residency reservations
until response delivery finishes or is cancelled. MCP reserves the large budget
for reads that can materialize a legacy archive. Every page and chunk rechecks
authorization, with OAuth admitted only for Task reads.
Schema3 reads validate the manifest and its independent timeline within the
same archive operation. The shared archive permit and timeline read lease
survive through delivery.
Resource previews share the unified media reference traversal, including
Markdown, reasoning and retained bindings. They project only six metadata
fields; the preview name accepts the unified image limit of 1024 UTF-8 bytes.
Explicit image failures and unresolved projections retain partial coverage.

Successful MCP reads keep public strict output schemas and protocol tests, with
ordinary runtime encoding. The dedicated history budget does not restore the
shared output validation or generic admission removed by the
[canonical resource reads decision](../simplification/2026-11-09-canonical-resource-pages.md).
The [history specification](../../../../docs/spec/task-session-history.md) and
[design](../../../../docs/design/task-session-history.md) own current contracts.

## Alternatives

**Reuse browser timeline results as original content.** Display placeholders can
lose large bodies while retaining plausible entry identities. Separate raw
reads preserve the display budget and make incomplete content explicit.

**Infer coverage from returned page bodies.** A body reference or conversation
filter can remove the evidence of a source gap. The source must retain that
fact independently of which entries and bodies fit in the response.

**Download an entire archive for client-side pagination.** This transfers and
retains up to 64 MiB for one short query and exposes archive layout to clients.
Server-side projection preserves the existing authorized archive reader and
bounded public responses, at the cost of cold full-archive materialization.

**Restore shared MCP output admission.** That would change unrelated read tools.
The history use case owns its budget, while published schemas remain validated
by protocol tests.

## Consequences

Clients can retrieve complete large entries without silently clipping text or
executing observed content. Old Controllers can serve short display entries,
but require an explicit upgrade for display-budget placeholders. Legacy archive
reads may still parse the complete archive; no permanent index or backfill is
introduced. Source or content changes can require a fresh read rather than
continuing an obsolete cursor.
