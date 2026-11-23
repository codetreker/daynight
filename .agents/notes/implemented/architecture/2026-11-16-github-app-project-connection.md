# Agent Note: Team-authorized Project App Connections

Status: implemented

## Problem

A remote repository proof can outlive the Team authority, App configuration, ownership or grant that allowed it. Connection changes also alter App removal impact sets and must serialize with revocation without reversing the App and Project lock order.

## Decision

Project connection operations use a dedicated App-aware scope and recheck original ownership, configuration, grant and connection conditions after remote verification. Current owner Team administrators manage connections; Project administrators retain synchronization settings. The scope reads candidate binding identities before locking sorted App roots and rereads the connection after waiting. The [connection design](../../../../docs/design/github-app-project-connection.md) owns the protocol, synchronization intent and adoption boundary.

## Alternatives

**Reuse the active global-App scope.** That scope locks the connection before the new App roots and serves existing production callers. Changing it would invert the required order and prematurely change public authorization.

**Keep a transaction open during remote verification.** Network delays would retain Project, Team and App locks. Proof outside the transaction followed by exact condition checks keeps lock holding local and rejects stale authority.

## Consequences

Connection changes participate in App impact versions and retain historical repository identity and pull requests. The final adapter is available for coordinated adoption while current public wiring continues to use its existing protocol. Unknown transaction outcomes require observation before another decision.
