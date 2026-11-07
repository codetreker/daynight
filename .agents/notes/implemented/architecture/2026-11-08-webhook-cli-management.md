# Agent Note: Webhook CLI Management

Status: implemented

## Problem

Webhook operators need explicit ownership, safe configuration changes and access
to delivery history from installed CLI entry points. A lost write response cannot
be resolved by comparing current configuration, and a destination or payload can
contain credentials that must not enter diagnostics.

## Decision

The CLI uses the authenticated management API with one verified actor and an
explicit Personal or Team owner. Each write fixes an operation identity, time and
hash of its actual request before dispatch. An optional private prepared record
contains only the binding needed to reconcile or explicitly resume that request;
matching the original receipt is required to confirm its effect. Endpoint lists
are bounded complete reads, while history reads expose one page. Payload exports
validate the original bytes before writing or publishing them. On Linux, an
inode handle and the destination directory are retained across the closed-writer
publication; procfs and glibc `linkat` are required for file export.

## Alternatives

**Infer an owner from the current project or default Team.** This would make the
same command target different resources as local configuration changes and could
silently address the wrong owner.

**Retry a lost write or compare current fields.** A retry with a new identity can
create another effect, and later changes can make current fields differ from the
original committed result. The receipt binds the original request instead.

## Consequences

Scripts must provide an owner and preserve the original input to resume a write.
The prepared record does not retain sensitive input or reconstruct it. Receipt
retention and admission windows limit later reconciliation and resubmission; a
missing receipt alone does not establish that the write was rolled back. The CLI
also checks a receipt's expiry against its local clock before confirmation, since
the management API can still return a retained row after its expiry. Clock skew
can therefore prevent confirmation. Normal
human output omits sensitive destination paths, and raw payload output preserves
its exact bytes. File export fails on platforms without the required inode-bound
publication. Temporary-name cleanup checks the inode before removal; that check
and removal are separate operations, so a process with equivalent directory
access can still race cleanup.
