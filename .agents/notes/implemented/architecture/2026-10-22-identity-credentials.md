# Agent Note: Persistent Identity and Credentials

Status: implemented

## Problem

The service needs a stable local user and revocable credentials for browsers and
unattended clients. UniAuth returns one-time normalized identity rather than a
Daynight session. Duplicate callbacks, concurrent first logins and result loss
must not create conflicting identities or silently repeat consumed operations.

## Decision

The identity foundation implements the adopted
[authentication architecture](../../../../docs/design/daynight-auth.md) as an
independently composable module. That initial staging kept existing resource
routes unchanged while identity and membership could be verified separately.
The [activation decision](2026-10-22-authentication-activation.md) now mounts the
module with all resource checks and required config; no anonymous or trusted-user
shortcut is exposed.

The existing UniAuth Go SDK is pinned to an immutable pseudo-version. A browser-
bound pending login is atomically validated and consumed in PostgreSQL before
one SDK identity retrieval. Provider errors terminate a valid pending operation;
retrieval cancellation, response loss and protocol failure require a new login.
The full external identity ID uniquely maps to a local user UUID; nullable profile
fields retain their meaning and email does not merge identities.

Sessions and personal access tokens are opaque high-entropy secrets represented
by hashes in PostgreSQL. Separate Session and PersonalAccessToken records express
their distinct expiry contracts: browser sessions expire after seven days, while
PATs default to no expiration and may carry a future UTC expiry. The raw PAT is
returned once. The [device-login decision](2026-10-25-cli-device-login.md) reuses
PAT storage for CLI authorization. A browser session can create named PATs and
modify an active token's nullable expiry while preserving its ID, hash and secret;
account and observed-expiry checks protect the update. Expired or revoked tokens
cannot be revived. Migration 018 makes only PAT expiry nullable and preserves all
existing finite expiry timestamps. Credential lookup checks current revocation
and any configured expiry; project roles remain outside credentials. Explicit
invalid Bearer authentication does not fall back to a browser cookie.

HTTP handlers validate exact main-site Origin on cookie-authenticated mutations
and use host-only session cookies. Production uses Secure, HttpOnly and Lax;
the initial module allowed explicit numeric-loopback HTTP development. The
activation decision now separates configured main-site HTTP testing from the
SDK gateway's literal-loopback allowance and owns current callback routing.
The [trusted same-origin attachment decision](2026-10-21-task-attachment-storage-design.md)
continues to apply without a preview domain, credential or gateway.

Real integration uses the exact pinned UniAuth source and its actual gateway,
App registry and GitHub provider. A test-only command controls upstream HTTP
responses for dynamic personas; Daynight and its SDK use the ordinary HTTP
protocol. The fixture runs inside the pinned upstream module because gateway
constructors are internal. Its source, executable, SQLite data and private
credential handoff belong to task-local temporary directories. The application
module has no workstation replacement or production dependency on that fixture.

## Alternatives

**Self-contained JWT sessions.** Immediate local revocation would still require
state checks, while introducing signing-key and token-claim lifecycle. Opaque
credentials reuse the existing PostgreSQL lifecycle and keep roles current.

**Implement provider OAuth in Daynight.** This duplicates the normalized identity
handoff and upstream adapters already owned by UniAuth. The existing SDK and
gateway protocol cover the confirmed identity requirements.

**Only an in-memory credential store.** Restart would revoke ordinary sessions
and tokens accidentally and would not support shared durable state. PostgreSQL
already owns the service's persistence and transactions.

**A fixed-user authentication endpoint as integration proof.** It cannot verify
UniAuth's browser state, App ownership, real provider normalization or result
consumption. Unit transport fixtures remain useful for targeted failures, while
the separate real-gateway fixture supplies the actual protocol proof.

## Consequences

The schema gains identity, pending-login and credential records without changing
existing projects. Expiry is checked during access, with bounded request-owned
cleanup rather than a new scheduler. Errors preserve their causes while logs
omit secrets, callbacks and raw upstream identity payloads.

The foundation was callable and testable before production mounting; that
sequence preserved reviewable identity semantics while other components were
prepared. Mandatory composition, membership and frontend/CLI integration now use
this foundation through the activation decision. Controlled upstream integration
does not claim a real third-party account login; that acceptance remains separately
recorded and current-source gate outcomes require their own receipts.
