# Agent Note: GitHub App Configuration and Removal

Status: implemented

## Problem

Changing an independent App's credentials can invalidate in-flight work for every connected Project, including Projects hidden from the App administrator. Deleting the App must also revoke its actual authority without erasing retained pull requests or allowing an old identity to become valid again.

## Decision

Credential changes are proved outside the App transaction, then committed only against the observed configuration and administrator membership versions. The App root serializes the write with membership, grant, and connection changes. A credential change advances connection fences and schedules access checks while retaining connection and synchronization intent. Removal checks configuration and impact versions and atomically removes administrators and invitations, revokes grants, stops connections, and erases secrets while retaining permanent identities and pull requests. The [configuration design](../../../../docs/design/github-app-configuration.md) owns the mechanism and adoption boundary.

## Alternatives

**Hold the App lock during remote proof.** A slow GitHub request would block unrelated administration and connection operations. Recording and rechecking the membership and configuration versions permits a short transaction without accepting stale proof.

**Clean only Projects visible to the administrator.** This would leave hidden Projects using revoked credentials or grants. Privacy applies to the preview projection, not to the transaction's complete affected set.

## Consequences

Credential and removal writes serialize affected connections and can cost more as the number of Projects grows. Unknown commit outcomes remain unknown after a read and must not be automatically repeated. The adapter remains unmounted until the coordinated independent App protocol is adopted.
