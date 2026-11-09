# Agent Note: Server Identity Boundaries

Status: implemented

## Problem

Identity operations combine one-time login consumption, an upstream claim, local
user and credential writes, and Personal Team initialization. Keeping those
operations on a concrete store couples domain rules to database transactions and
makes it difficult to preserve their ordering while separating HTTP adapters and
other domains. Shared cursor and HTTP helpers also need owners that do not depend
on the root service or server packages.

## Decision

`core/identity` owns identity rules and receives transaction-bound DAO
capabilities. `service/identity` coordinates the upstream client and local
transactions, including Personal Team bootstrap through `core/team`. Login
consumption completes before the upstream request; user, Personal Team and
session writes share a local transaction. Transaction completion failures take
precedence over staged business refusals and an uncommitted secret is not
returned.

`core/query` owns the independent list and scoped-project cursor codecs;
`core/model` owns shared value validation and `utils/secret` owns secret
encoding and hashing. `server/auth` adapts identity to HTTP, while `server/httpx`
owns shared HTTP parsing, responses and logging. Authentication settings and
configuration errors are neutral values in `internal/config`.

## Alternatives

**Keep concrete store operations in the identity service.** This retains the
existing call shape but leaves transaction-bound operations coupled to the
PostgreSQL implementation and duplicates the work needed for later separation.

**Merge all cursor formats into one schema.** This would simplify the codec
surface but change the established payloads, versions and scope bindings used by
existing clients.

## Consequences

Identity and the shared helpers can be consumed without importing the root
service or server packages. Existing cookie, credential, cursor and error
semantics remain part of their respective adapters and codecs. The
[PostgreSQL backend](2026-11-05-server-postgres-ownership.md) owns database
implementation details. This decision does not change application lifecycle or
the rest of Team behavior. The [snapshot reader decision](2026-11-05-server-snapshot-readers.md)
continues to govern shared reads and completion facts.
