# Agent Note: Read-only Terminal History Boundary

Status: implemented

## Problem

Uploaded terminal recordings must remain readable under the original Session
identity and authorization even when execution and control capabilities change.
The persisted terminal document also contains live control state; coupling
archive reads to its full runtime model makes historical access depend on those
capabilities. Task property reads face the same problem when stored Worker
identities outlive the admission rules for new claims.

## Decision

Session history and terminal archive reads decode the persisted envelope, owner,
runs, recording evidence and finalization identity needed for archive validation.
They retain the existing permission scope, archive reservation, receipt and
content integrity checks. Live operations retain their existing full record and
admission. The persisted JSON and uploaded bytes do not require migration.

Worker property persistence recognizes historical Herdr documents and Web
records with either a null or absent Herdr field independently of new-claim
validation. Re-encoding retains the historical resource identity. The write
admission contract remains unchanged. The TypeScript archive decoder and frame
parser share read-only recording types and functions; strict JSON decoding has
its own generic owner. Live protocol callers retain their existing exports.

The [terminal server design](../../../../docs/design/terminal-session-server.md)
and [v2 contract](../../../../docs/design/session-v2-contract.md) describe the
current boundaries. The [archive layout decision](2026-11-05-session-archive-layout.md)
continues to govern persisted object addresses and retention.

## Alternatives

**Keep the full live record as the archive model.** This keeps one decoder but
makes read-only history depend on runtime and control fields that are not needed
to establish the recording's identity and integrity.

**Rewrite stored records or archives into a new format.** Existing data already
contains the required evidence. Migration would add failure and recovery duties
without improving the retained read contract.

## Consequences

Historical reads can retain their own proof without starting or recovering an
execution. They still reject unauthorized, missing or corrupt content and retain
the original archive lifecycle. The additional read-only model must stay aligned
with the persisted fields used by integrity validation; admission changes must
not be used as a substitute for its historical decoding contract.
