# Agent Note: Project GitHub PR Storage

Status: implemented

## Problem

Projects need retained GitHub pull request observations and independent connection state without changing the existing Project and Task contracts. Reads need a consistent view of permissions, status, counts and data, while later synchronization must distinguish configuration changes from connection replacement and new observations.

## Decision

Store connection facts, pull requests and pending refresh hints in separate Project-scoped tables. Missing connection rows represent a virtual disconnected resource; reads do not create rows. Configuration version, connection generation and visible revision have separate purposes. A Project write scope provides explicit configuration and lease-bound coordination mutations, and a repeatable-read snapshot provides bounded summary, count and detail reads. A separate broadcast transaction locks matching GitHub rows before pending hints without acquiring Project locks. The [storage design](../../../../docs/design/github-pr-storage.md) describes identities, nullable fields and transaction boundaries.

## Alternatives

**Reuse Project settings or Task pull request links.** Those fields have different ownership and consumers; embedding synchronization state there would alter existing contracts and couple Task cache updates to observations.

**Share a repository mirror across Projects.** A shared mirror introduces authorization and retention relationships between independently managed Projects. Separate storage costs duplicate observations for Projects using the same repository but preserves their isolation.

## Consequences

The storage provides coordination primitives independently of the connection endpoint and worker. Retained raw descriptions and nullable source identities preserve upstream facts. Separate counters and explicit writes require producers to honor the same boundaries; the database does not implement their business state machine. Replacing a pending request ID prevents an older acknowledgement from consuming a newer hint, at the cost of a possible additional fetch. The [synchronization setting decision](2026-11-14-project-github-sync-setting.md) extends the same generation and lease fence to independent Project synchronization intent.
