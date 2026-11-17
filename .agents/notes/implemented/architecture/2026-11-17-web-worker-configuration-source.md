# Agent Note: Preserve Web Worker configuration source

Status: implemented

## Problem

A configuration editor that reconstructs its PUT from known fields loses future
fields. Parsing unknown JSON numbers as JavaScript numbers also rounds some values,
so accepting extra keys alone cannot preserve the target. A later read or receipt
can additionally bind an old draft to the wrong revision or falsely confirm a
write whose unknown values differ.

## Decision

The Web configuration endpoint retains the validated response source alongside
its strictly validated known view. The editor binds its draft to a baseline from
one response and merges known changes into that baseline. It freezes the merged
source and revision for a submission and compares complete semantic values when
checking receipts and uncertain outcomes. Project entities match by ID; unknown
arrays keep their order and numbers compare without floating-point conversion.
The existing mode and tool-path admission rules still select their wire projection.
Unknown observation items are retained but are not rendered as applied. The saved configuration response and conflict details display the source attached
to the selected response, so unknown fields and number spelling remain visible
while editing the draft. Capability negotiation may omit fields from that source;
the UI states this limit rather than presenting it as a complete stored target.

The [configuration specification](../../../../docs/spec/daynight-worker-configuration.md#web-消费者)
owns observable behavior and the [design](../../../../docs/design/daynight-worker-configuration.md#web-字段与保存)
owns the data flow. This complements the [save settlement decision](../bug-fix/2026-11-11-worker-configuration-save-settlement.md)
and [tool path editing decision](../feature/2026-11-12-worker-tool-path-web.md).

## Alternatives

**Ignore unknown keys and serialize the known view.** This accepts a future
response but deletes its unrecognized data on the next save, including values
that cannot be represented exactly as JavaScript numbers.

**Introduce a new capability or endpoint for each future field.** The chosen
migration uses the existing resource and requires compatible clients to be adopted
before the service adds fields. Another negotiation would add protocol and
rollout state without preserving unknown data in already compatible clients.

## Consequences

Known fields retain their existing validation and editing behavior, while unknown
values survive known edits and receipt checks. Source validation and entity-aware
merging add code local to this endpoint. A strictly parsing older page remains
incompatible until refreshed to the compatible version; code delivery alone does
not prove that active clients have adopted it.
