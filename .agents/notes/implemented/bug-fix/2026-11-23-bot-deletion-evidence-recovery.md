# Agent Note: Bot deletion recovery after execution evidence loss

Status: implemented

## Problem

A deleted Bot projection omits its former Session definition. After local evidence
loss, an empty record can be mistaken for an execution that never existed.
Persisting a null or unsupported never-started proof as local completion then
causes repeated receipts that the server rejects. Deleting the recreated store
cannot recover the lost identity or prove that cleanup finished.

## Decision

The [Worker deletion path](../../../../docs/design/worker-bot-runtime.md) preserves
`failed/execution_evidence_missing` through the existing Bot observation and
failure-receipt protocol. Automatic reconciliation keeps reading the original
deletion but stops repeating destructive work and the same invalid receipt.
There is no new server protocol, stored field or alternative completion state.

`daynight bot recover` is an explicit operation on the original execution's
machine. It acquires existing locks, checks the original deletion and local
ownership, and reuses the existing Controller stop and private-cleanup code.
Complete retained evidence can support the ordinary completed receipt. If an
execution row is lost but its intent, ticket and journal still validate, the
command can stop that generation and retain its real journal proof; missing
historical cleanup evidence still leaves deletion failed. It creates no
replacement execution or partial cleanup plan. Ordinary Worker operation and
automatic retries do not use this local compensation.

The [website](../../../../docs/design/bot-management-web.md#删除协调) reads the
existing Bot status for known deletions, shows the CLI instructions and preserves
the ordinary completion rules. It cannot settle missing evidence.

## Alternatives

**Only suppress repeated receipts.** This avoids the loop but does not use valid
remaining local material to stop the original execution. Explicit compensation
recovers that opportunity without making automatic retries destructive.

**Accept null proof or report completed after user confirmation.** Neither an
empty store nor an attestation proves that the bound native execution stopped.
A later reboot also lacks attribution when the original machine/boot evidence
was not retained. These shortcuts would erase the meaning of ordinary completion.

**Add server settlement, browser confirmation and account recovery history.**
Independent unverified decisions could permit server cleanup despite lost local
evidence, but introduce another lifecycle, mutation recovery and discovery
contract. They are outside this repair. Evidence loss may remain a failure;
future settlement work would need its own retained identity and late-receipt
rules, without weakening the existing proof-based completion contract.

## Consequences

The invalid retry loop ends across restarts while remaining evidence can still
support explicit local compensation. A crash between saving intent and the
first execution row is indistinguishable from later row loss, so that narrow
window also fails conservatively. Persisted not-submitted or definitive launch
rejection still supports ordinary never-started completion.

Stopping a retained generation alone does not prove historical private cleanup.
The CLI reports that distinction and preserves the original journal and ticket.
If evidence cannot be recovered, the Bot can remain failed and server cleanup is
not guaranteed. No process is identified by name alone, no ordinary cwd or shared
Provider history is removed, and no shared PAT is revoked.
