# Agent Note: Bot Location and Availability Observations

Status: implemented

## Problem

A Bot can remain readable after its Worker disappears or its original PAT
expires. Creation-time Worker identity and a persisted ready result cannot show
its current host or prove current activity. Ordinary Worker inventory hides old
reports after 72 hours, and durable Session snapshots intentionally omit live
synchronization and activity.

## Decision

A separate versioned observation endpoint combines current Bot ownership,
durable hosting and Session identity, and committed live Session scalars. The
[assistant design](../../../../docs/design/assistant.md#服务端观测-v1-协议)
owns the read sequence, status precedence, expiry rules and public contract.

The source query reuses existing permanent Worker, Bot recovery and Session
records without the inventory age filter. Recovery machine identity remains
authoritative; a report from that same machine supplies its latest name.
Current hosting differs from the frozen creation Worker as established by the
[takeover decision](2026-11-19-bot-server-takeover.md).

The service reauthorizes and rereads durable state after sampling live state.
Changed versions, relay ownership, Controller fences or revoked leases cannot
publish old activity as current. Reads neither load the original PAT nor enter
the Session browser lifecycle. No output field grants input authority.

## Alternatives

**Extend ordinary Bot responses.** Existing clients strictly decode their shape,
and their Worker field denotes frozen creation configuration. An independent
endpoint preserves that contract while making current hosting explicit.

**Reuse the browser TestSnapshot operation.** That path checks the original
parent credential, can advance archive lifecycle, and loads more live data than
availability needs. A committed scalar sample preserves read-only behavior and
current-account authorization without relaxing execution admission.

**Read only PostgreSQL activity.** Durable snapshots intentionally remove live
activity and synchronization. Treating them as current would misreport idle or
working after reconnection or takeover.

**Add another location table.** Existing Worker rows retain last reports and
Bot recovery records retain machine identity. A second copy would add write
coordination without supplying a missing persistence lifetime.

## Consequences

Offline Bots retain location and native identity beyond the inventory window.
Observers can distinguish startup, recovery and confirmed failures without
starting an Agent or changing claims. The endpoint costs two small database
snapshots per Bot observation. A request handled by a different relay reports
unavailable live observation instead of inventing activity; cross-relay scalar
distribution and Web presentation remain separate consumers.
