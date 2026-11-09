# Agent Note: Webhook Plaintext Storage

Status: implemented

## Problem

Webhook management, capture, delivery and restart need consistent recoverable destinations and signing credentials. The initial storage design encrypted current endpoint targets, signing secrets and every Delivery target independently. That coupled master-key maintenance to accumulated delivery history and added keyring distribution, rewrapping, recovery scans and retirement coordination before the service had been deployed.

## Decision

Endpoint and Delivery targets store canonical destination JSON as plaintext `bytea`; each Delivery keeps its own immutable snapshot. Signing keys store exactly 32 random plaintext bytes. The eleven-table persistence model retains its event, delivery, original-match, attempt, receipt, authorization, policy and retention responsibilities. No destination-version or owner-DEK table is introduced.

The application has no storage cipher, master key, keyring, encrypted envelope, rewrapping command or key-retirement lifecycle. Endpoint and target decoders validate size, known fields, versions, URL and row metadata. History and endpoint cursors use strict Base64 URL JSON with current scope, disclosure and position checks; each request independently authorizes the resulting query. Cursors contain no credentials or payload and grant no access.

HMAC-SHA256 request signatures remain part of the outbound protocol. Random signing secrets, current and overlap keys, HTTPS certificate and address checks, original request bytes, continued authorization, original subscription proofs, admission, leases, retries, explicit redelivery and bounded retention remain enforced. A signing-key rotation generates a new secret; it does not rewrite destination snapshots or delivery history.

The service is not deployed, so its unpublished migrations define the plaintext schema directly and isolated databases are rebuilt from those migrations. There is no legacy ciphertext transition or compatibility decoder. The [management](../architecture/2026-11-07-webhook-management.md), [capture](../architecture/2026-11-07-webhook-atomic-capture.md), [delivery](../architecture/2026-11-08-webhook-safe-delivery.md), [history](../architecture/2026-11-08-webhook-history-redelivery.md), [retention](../architecture/2026-11-08-webhook-retention.md) and [runtime](../architecture/2026-11-08-webhook-application-runtime.md) decisions retain their independent transaction and authorization rationale.

## Alternatives

**Retain per-record authenticated encryption.** The initial design made stored targets and signing credentials recoverable only with a configured master key and bound them to their resources. Every retained Delivery target also became a master-key reference; rotation and restore verification therefore grew with delivery history, and an unavailable old key could block startup or retained work.

**Encrypt only URL and signing secrets.** This reduces encrypted content, but encrypting each fixed Delivery URL still makes cryptographic maintenance grow with deliveries. Removing unrelated encrypted fields alone does not resolve that coupling.

**Use owner data-encryption keys and shared destination versions.** The discussed envelope proposal would let master rotation rewrap configuration-owned keys while fixed deliveries reference shared targets. It requires a new ownership and reference lifecycle, garbage collection and key-access design across capture, delivery and restart. Application-level encryption and this structural redesign are deferred so the complete notification flow can use direct storage. Reintroducing encryption would require an explicit design whose encrypted maintenance scale follows owners and configurations, not Delivery count.

## Consequences

Startup and restart depend on current policy and persisted signing/wait references without an external encryption-key dependency. Management changes that retain a target or signing secret do not rewrite it; delivery retries and redelivery retain the original target and body. Database size still grows with per-Delivery snapshots and retention, but there is no encrypted-data maintenance workload proportional to those snapshots.

Database readers and backup readers can read retained URL tokens, target configurations and signing secrets. Application authorization, ordinary projection redaction, separate secret reads and safe diagnostics continue to restrict application-level disclosure; they do not provide database confidentiality. Backup access has the same sensitivity as access to the stored rows. Future storage encryption changes this exposure and requires redesign of configuration/key ownership and reference lifetime; it is not a free field-level addition.
