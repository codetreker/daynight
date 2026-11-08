# Agent Note: Server File Storage Ownership

Status: implemented

## Problem

Generic byte storage is shared by attachments and Session archives. Its contract
and local implementation need a stable low-level owner that consumers can use as
server business and integration responsibilities move into separate packages.

## Decision

`internal/core/filestorage` owns the bucket/path contract, address validation,
and errors. Its `local` subpackage owns the root-confined filesystem implementation
and Namespace-restricted archive cleanup. Consumers use these packages directly;
`internal/core/model/sessionarchive` supplies the shared archive address value.
The [attachment design](../../../../docs/design/daynight-task-attachments.md)
describes the storage contract, and the [original storage decision](../../archived/architecture/2026-10-21-bucket-file-storage.md)
retains the rationale for root confinement and complete-file replacement.

## Alternatives

**Keep the old package as a forwarding alias.** Maintaining two import paths
would prolong split ownership and require later consumer migrations without adding
storage behavior.

## Consequences

The existing storage implementation and its tests move together. Addresses,
bytes, cancellation, failure chains and cleanup boundaries remain unchanged.
Attachment policy, Session ownership selection and resource lifecycle remain
with their respective owners; the storage package does not acquire their runtime
dependencies. Existing files are neither moved nor searched under alternate paths.
