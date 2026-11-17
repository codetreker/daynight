# Agent Note: Omit Herdr from Web claim writes

Status: implemented

## Problem

Web execution no longer uses Herdr resources, but its claim updates still carried
a null slot. Historical claims and older Web records must remain readable while
new execution requests have a single unambiguous format.

## Decision

Claim POST and PATCH reject the `herdr` member, including null. New Web claim
properties omit it. Stored Web records accept both the former null and omission;
historical Herdr records retain their mode and resource on encoding and reading.
CLI and Web readers accept both Web forms. Worker-Protocol:2 and claim ownership
checks remain unchanged. The [claim design](../../../../docs/design/daynight-worker-claims.md)
owns the operation contract. This narrows the wire retained by the earlier
[Web-only write decision](2026-11-17-web-only-worker-writes.md).

## Alternatives

**Retain the null request slot.** This would preserve a field with no role in
Web execution and continue admitting the obsolete request format.

**Remove the field from all stored claims.** This would discard historical Herdr
resource identity and impair ordinary task reads.

## Consequences

Older Workers that send the slot must be upgraded. Existing Herdr resources
remain under user control; this change does not migrate or clean them up.
