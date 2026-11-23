# Agent Note: Azure Ordinary Object Storage

Status: implemented

## Problem

Attachments, Session media and private transfers need durable object bytes on an
Azure container while preserving existing logical addresses, publication outcomes,
read views and scoped cleanup. Attachment paths can exceed Blob name limits, and
the local filesystem's open-file behavior does not carry over to remote reads.

## Decision

The Azure ordinary-object adapter maps each logical bucket to a container prefix.
Attachment keys retain the project and Task scope and hash the original relative
path; runtime access and migration share that mapping. A complete input is staged
on local scratch before a single publication attempt at the fixed key. This keeps
an explicit service rejection distinguishable from a lost response after a
possible write. An opened read uses its initial ETag for retries. Typed namespace
cleanup lists every page and checks each delete.
The adapter accepts independently supplied gates, and private-object capacity
continues to use the PostgreSQL ledger rather than local volume capacity.

The [attachment design](../../../../docs/design/daynight-task-attachments.md)
owns the current storage contract. The [file storage ownership decision](2026-11-05-server-file-storage-ownership.md)
retains the package boundary; the [attachment target gate decision](2026-11-06-attachment-target-gate.md)
retains publication ordering and its cross-store failure boundary.

## Alternatives

**Store the full attachment path in the Blob name.** Existing valid long and
multibyte paths can exceed remote name limits, even though PostgreSQL and the
public API accept them.

**Use immutable object keys and a database pointer.** This would change the
existing fixed-path lifecycle and require separate version reclamation.

## Consequences

The adapter can be verified independently of service selection. Scratch writes
consume local disk until publication finishes, and failures retain their reported
publication outcome. An ETag mismatch on a retried read is an error rather than
permission to substitute new bytes. Azure service configuration, identity wiring
and streaming archive support are separate work; ordinary objects alone do not
enable the Azure runtime backend.
