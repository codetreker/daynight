# Agent Note: Webhook subscription continuity

Status: implemented

## Problem

Outbound configuration can outlive the authority under which it was created. Current Project access alone cannot distinguish continuously authorized access from revoke-then-regrant, and an endpoint's creator is not the owner of a shared Team endpoint. Management response loss can also leave the caller uncertain whether configuration took effect. Recoverable signing material must remain private while retaining the ability to decrypt records after a master-key change.

## Decision

Endpoint ownership, selected Projects, persistent authorization epochs and stable event bindings are separate identities. ACL writers refresh retained subscriptions within the original source transaction. Continuous membership/grant handover preserves eligibility; a real gap requires explicit confirmation. Restrictive cleanup requires current management authority without restoring payload or send rights.

The configuration module uses neutral scoped DAO contracts and a PostgreSQL backend. Source-container locks precede endpoint/subscription locks; a post-wait refresh reads the effective permission union in a fresh Read Committed statement without acquiring new source locks. Project deletion has its own scope. Team-owned subscriptions remain Team resources when their creator leaves.

After an original receipt is absent, current management authority is required before a new invocation acquires source locks. The advisory pre-read version also fences the lock plan: caller version, observed planning version and locked current version must agree. An anticipated future version cannot admit a newly expanded selection using an older restrictive lock plan. Existing receipt recovery retains its narrower current read authority.

Configuration effects and bounded operation receipts commit together. Receipt identity includes the original issuedAt and server-calculated request-body SHA-256 as well as a canonical semantic fingerprint. Existing receipts are checked before new-operation freshness. An absent receipt or an uncertain COMMIT cannot establish rollback.

Each non-ciphertext metadata record, including its parent identities and public destination origin, must fit the serialized 2 KiB billing envelope. Ciphertext adds its actual persisted byte length. A syntactically valid destination must still pass this accounting boundary before reservation; variable public metadata cannot be hidden inside the fixed charge.

Authenticated recoverable storage uses an immutable runtime AES-256-GCM keyring. Each write uses a fresh twelve-byte nonce, and associated data binds both envelope metadata and a separate resource context. New ciphertext uses the active master; old keys recover retained records. The current management module is independently mountable, while public application registration requires a complete capture/delivery backend.

The [subscription design](../../../../docs/design/outbound-webhook-subscriptions.md) owns mechanisms, permissions and validation boundaries.

## Alternatives

**Recheck only present permission.** This cannot observe a temporary authorization gap, so old pending history would become eligible after regrant. Persistent epochs record the gap while allowing a continuous independent-grant handover.

**Derive shared ownership from the creating administrator.** This would tie a Team resource to one membership and incorrectly invalidate it when its creator leaves. Stable Team ownership separates resource authority from the creator's current management rights.

**Send configuration changes without operation receipts.** A lost response cannot reveal whether the effect committed. Bounded receipts retain the original request binding without storing a duplicate secret or requiring automatic replay.

**Hash signing secrets.** One-way token hashing cannot recover HMAC key bytes for a later request. Recoverable authenticated encryption protects the stored material and binds it to its intended record. AES key sizes and GCM behavior follow the [Go AES documentation](https://pkg.go.dev/crypto/aes#NewCipher) and [AEAD documentation](https://pkg.go.dev/crypto/cipher#AEAD).

**Cap the entire destination URL at the metadata envelope size.** Only the origin is public record metadata; paths and queries belong to encrypted configuration and are billed by actual ciphertext bytes. A blanket URL cap would remove valid capacity while avoiding the required per-record accounting proof.

## Consequences

All ACL paths that can change effective Project access participate in the refresh contract, including invitations, transfers and deletion. New paths must preserve this invariant. Configuration transactions acquire explicit source fences and quota records; the cost is a wider transaction contract and bounded retained state.

Old master keys remain required while records or retained backups reference them. Runtime master rotation and endpoint signing-key rotation remain distinct. Missing keys, authentication failures and capacity failures stay observable. Public configuration must wait for the complete delivery composition, so storing an endpoint never promises a currently absent dispatcher.
