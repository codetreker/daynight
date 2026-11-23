# Agent Note: Resume Archives from Storage Offsets

Status: implemented

## Problem

The stopped Controller rejects receiving offsets that are not multiples of
512 KiB unless they equal the full length. An Azure Append Blob can hold a valid
short append at such an offset, so the original frozen file cannot resume even
though the server reports its actual committed length.

## Decision

Version 2 history, timeline and migration-only resource transfers accept every
canonical offset within the bound file length. The receipt parser validates the
number, state and range; transfer validation retains file identity, length,
digest and protocol checks. The remaining stream reads the original frozen
source at the exact accepted offset in chunks of at most 512 KiB. Full-length
receiving receipts still require explicit completion.

The [streaming upload decision](../architecture/2026-11-23-archive-streaming-upload.md)
owns transport reconciliation. The [Azure backend decision](../architecture/2026-11-23-azure-archive-backend.md)
owns actual Blob-length recovery; local staging retains its durable block policy.

## Alternatives

**Keep the local alignment guard for every backend.** This rejects valid Azure
prefixes and cannot satisfy recovery from actual Blob length. Rounding that
length would also conflict with Azure's position-checked append.

## Consequences

The Controller resumes from a valid short prefix without replacing fileId or
weakening full-file verification. Source chunk size remains bounded independently
of the storage offset. Controlled transport tests prove byte-exact resumption
and refusal behavior; actual Server/Azurite validation supplies evidence for the
backend and stopped Controller path. Natural network interruption yielding a
specific nonaligned prefix remains distinct from deliberately prepared staging.
