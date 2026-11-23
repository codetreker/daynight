# Agent Note: Webhook CLI Management

Status: implemented

## Problem

Webhook operators need explicit ownership, safe configuration changes and access
to delivery history from installed CLI entry points. A lost write response cannot
be resolved by comparing current configuration, and a destination or payload can
contain credentials that must not enter diagnostics.
Clients and services can upgrade independently, so reading the event catalog
must also work before and after Steps subscriptions retire without losing the
ability to read known historical events or configure a supporting service.

## Decision

The CLI uses the authenticated management API with one verified actor and an
explicit Personal or Team owner. Each write fixes an operation identity, time and
hash of its actual request before dispatch. An optional private prepared record
contains only the binding needed to reconcile or explicitly resume that request;
matching the original receipt is required to confirm its effect. The original
UTC timestamp text is preserved through request serialization and receipt checks.
A refusal of a caller-supplied identity does not establish the outcome of an
earlier request using that identity. Endpoint lists
are bounded complete reads, while history reads expose one page. Payload exports
validate the original bytes before writing or publishing them. On Linux, an
inode handle and the destination directory are retained across the closed-writer
publication; procfs and glibc `linkat` are required for file export.

Catalog decoding requires exactly one of each continuing Task event and permits
one optional `task.step_updated` entry, preserving the service's order. Every
entry retains strict wire type, schema version and resource kind validation.
Known event decoding for subscriptions and delivery history is independent of
the subscribable catalog. Configuration input retains Steps events for supporting
services, and writes let the service decide availability without a catalog read.

## Alternatives

**Infer an owner from the current project or default Team.** This would make the
same command target different resources as local configuration changes and could
silently address the wrong owner.

**Retry a lost write or compare current fields.** A retry with a new identity can
create another effect, and later changes can make current fields differ from the
original committed result. The receipt binds the original request instead.

**Require all six known events.** This prevents the CLI from reading a catalog
after the service retires Steps subscriptions, even though its other commands
remain usable.

**Read the catalog before configuration writes.** This adds a network dependency
to every write and still cannot replace the service's final availability check.

## Consequences

Scripts must provide an owner and preserve the original input to resume a write.
The prepared record does not retain sensitive input or reconstruct it. Receipt
retention and admission windows limit later reconciliation and resubmission; a
missing receipt alone does not establish that the write was rolled back. The CLI
also checks a receipt's expiry against its local clock before confirmation. The
service independently enforces logical expiry with its database clock, as
described by the [receipt lifetime decision](../bug-fix/2026-11-08-webhook-receipt-results.md).
Clock skew or a deadline crossed during transport can still prevent local
confirmation of a response that was valid when projected. Normal human output omits sensitive destination paths, and raw payload output preserves
its exact bytes. File export fails on platforms without the required inode-bound
publication. Temporary-name cleanup checks the inode before removal; that check
and removal are separate operations, so a process with equivalent directory
access can still race cleanup.

One CLI artifact reads both catalog shapes while malformed catalogs fail
explicitly. A future event needs an explicit decoder update. Accepting a known
event locally does not promise that the connected service allows a subscription.
