# Agent Note: Shared Bot availability and location in the Web interface

Status: implemented

## Problem

A persisted successful startup does not establish that an assistant is online.
The creation Worker can differ from its current host, and another assistant on
the same machine can be working while this one has failed. Readers need the
same status in the list, conversation title and details, with enough location
and failure information to investigate. A delayed or retained response must not
extend the lifetime of a live claim about activity.

## Decision

The Web interface consumes the independent versioned endpoint established by
the [server observation decision](2026-11-20-bot-availability-observation.md).
The [management design](../../../../docs/design/bot-management-web.md#统一标题与状态来源)
owns the API decoder, shared page-level observation hook and presentation flow.
One Bot observation supplies the list, title and details. It keeps current
hosting separate from frozen creation configuration and resolves Worker aliases
against the observed Worker ID.

Each record expires independently. Server-relative freshness is charged from
the request's start on the browser's monotonic clock, including transport and
publication waits. A repeated observation cannot renew its old deadline.
Expiry removes live status even without another successful response; retained
location, identity and reason remain explicitly dated historical facts.
An offline response has no online deadline and receives only the short polling
window for its most recent confirmed offline result.

Account scope, Bot identity, request cancellation, definition versions,
execution generations and observation times constrain publication. A denied
read clears its observation; a transient failure preserves dated facts without
claiming live availability. Bounded concurrent reads share one owner and each
Bot's in-flight protection.

Details associates known failures with checks on the original machine and
preserves unknown reason codes. Refresh reads the status only. Neither a
recovery suggestion nor an observed idle or working state changes Session
authorization, sends input, takes over execution or retries an unknown operation.
The original Session continues to own its connection errors, approvals, receipts
and settings.

This partially supersedes the status placement in the
[conversation-first presentation decision](2026-11-05-assistant-management-presentation.md).
That decision reduced persistent diagnostic detail and preserved the original
Session controls. Those layout and lifetime choices remain; current machine
location now belongs in the list, while detailed causes and remedies remain in
the information panel.

## Alternatives

**Keep startup results and Worker defaults as status inputs.** These sources
describe successful initialization and creation configuration. They cannot
identify the current host or distinguish independent activity among Bots on the
same machine. Combining them in the browser would duplicate incomplete server
rules and could display a healthy state after recovery failure.

**Keep the mounted Session as the title's status source.** Cold, offline and
unbound assistants do not have the same mounted live state as an active pane.
Using a different source there would make title and list disagree. Shared
observation supplies availability while the original Session retains actual
operation admission and detailed runtime feedback.

**Fetch status independently in each visible component.** Separate polling
cycles would produce different samples and deadlines for the same assistant,
increase request volume and duplicate cancellation ownership. A page-level
record lets every consumer use the same observation and expiry decision.

**Give each received response a full freshness interval.** This would extend
old evidence by network and publication delays. Comparing the absolute server
deadline only to the browser wall clock would also depend on clock alignment.
Server-relative duration measured from the request start is conservative and
remains independent of local wall-clock adjustments.

## Consequences

Users can locate an offline assistant and distinguish recovery from confirmed
failure without opening or restarting its Provider. The same-machine context
does not collapse independent Bot states. Existing readable Session content,
drafts and controls retain their owners.

The endpoint adds one read per displayed or selected Bot per polling cycle,
with a concurrency bound rather than a batch API. Large lists can leave some
observations stale while queued requests complete; stale labels preserve this
limit instead of inventing freshness. Per-record deadlines require timer and
controlled-clock tests in addition to API and component tests.

Observation records are page memory, not an additional persistent history
cache. Server aggregation, native recovery and cross-machine takeover remain
outside Web presentation. Browser fixtures establish responsive geometry and
keyboard behavior; they do not prove those server or Provider mechanisms.
