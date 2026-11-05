# Agent Note: Server Shared Model Ownership

Status: implemented

## Problem

Service operations, storage, and protocol adapters share entity values, error
identities, and archive addresses. Placing these contracts alongside business
operations makes their ownership and dependency direction harder to preserve as
server responsibilities are separated. A stable rule also needs to survive module
moves without becoming an inventory of the current directories.

## Decision

Shared data, their pure methods, cross-layer error values, and the pagination
request live in `internal/core/model`. The archive namespace value contract lives
in `internal/core/model/sessionarchive`, where writers and cleanup derive the same
physical address. Business error classification, database contracts and operations
remain with their existing owners.

The [server organization rules](../../../../docs/daynight-server.md) establish
stable responsibilities and dependency directions, while source and design
material describe actual modules and mechanisms. The initial concrete store and
shared models were introduced together for the reasons recorded in the
[transactional storage decision](../../archived/architecture/2026-10-19-server-transactional-storage.md).
The shared data now have a separate low-level owner; existing store transaction
semantics remain unchanged.

## Alternatives

**Keep shared data in the top-level core package.** Consumers would continue to
import a broad package rather than a dedicated data owner, making later separation
of business modules and data-access implementations more difficult.

**List all current modules in the rules.** Every addition or move would require
updating a stable policy document, duplicating the structure already owned by
source and architecture documentation.

## Consequences

Consumers use one model package directly and retain the same data and error
semantics. The namespace continues to derive the same owner, shard, Session and
digest paths. This move does not itself relocate business operations or establish
new store interfaces; those responsibilities remain in their current owners.
The rules are maintained when rules change, and do not add a CI or import gate.
