# Agent Note: Azure Archive Backend

Status: implemented

## Problem

The Azure ordinary-object adapter cannot support streaming archive uploads by
itself. Resumption must observe committed bytes without assuming a local file's
block boundary, and publication must use the same bytes that passed validation.
Operators also need a bounded, authenticated startup check before selecting the
remote backend.

## Decision

The service selects local storage by default or an explicitly configured Azure
container. Azure uses Managed Identity or a separate Azurite connection string,
and checks container access within the startup deadline. Its archive staging
uses one Append Blob per file, conditional creation and position-checked
appends under a renewable finite lease. The actual Blob length is the recovery
offset. The stream receiver uses 1 MiB chunks for Azure and keeps the local
512 KiB policy. Validation and publication are bound to an ETag view; terminal
receipt confirmation precedes staging cleanup.

The [ordinary object decision](2026-11-23-azure-ordinary-object-storage.md)
owns object mapping and the [single-file staging decision](2026-11-23-archive-single-file-staging.md)
owns the local storage contract.

## Alternatives

**Round Azure offsets to local block boundaries.** A committed short append can
leave a valid nonaligned length; rounding would discard its actual recovery point
and position-checked append cannot safely overwrite the existing bytes.

**Publish by rereading the latest Blob.** A changed source could differ from the
validated bytes; the ETag binds the later read to the validated view.

## Consequences

Remote errors can leave an append or publication outcome unknown and require
observation of the original object. Azure storage depends on container access
and local scratch capacity. Real Managed Identity and Azure service semantics
still require validation in the deployment environment. The local backup
verifier remains limited to paired local volumes.
