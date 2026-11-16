# Agent Note: Preview SSO Identity

Status: implemented

## Problem

An isolated attachment preview origin needs a browser credential without
receiving the main site's cookie. It must retain the existing session's user,
expiry and revocation, and a one-time exchange must not issue two credentials
or leave a consumed code without the corresponding session update.

## Decision

Identity supports a short-lived SSO login record and a separate random preview
credential hash on the existing session. State and code are stored as hashes;
code consumption and the session hash update share a transaction. Completion
checks the actual preview credential against the source session before returning
the saved target. Only a confirmed commit returns a secret. The
[identity design](../../../../docs/design/daynight-auth.md) describes the data
and module boundary; [explicit browser SSO](2026-11-16-preview-sso-http.md) owns HTTP adoption.

The [identity boundary decision](2026-11-05-server-identity-boundaries.md)
continues to assign business rules to Core, transaction coordination to Service,
and SQL and locks to the PostgreSQL store. The earlier
[credential decision](../../archived/architecture/2026-10-22-identity-credentials.md)
records the original main-site session and trusted preview context.

## Alternatives

**Copy the main-site credential to the preview domain.** This exposes the same
secret to a broader cookie scope and defeats the separate credential boundary.

**Create an independent preview session.** A second lifecycle would require
separate revocation and expiry coordination instead of inheriting the existing
session's authority and deletion.

**Transport an encrypted credential.** This adds key management and an encrypted
handoff while the existing database can atomically exchange a one-time code.

## Consequences

Existing sessions remain valid with no preview hash until SSO completes. A later
exchange replaces the preview hash, so concurrent exchanges or account switching
can leave a browser with an invalid cookie; a new SSO can recover. A lost commit
acknowledgment is not proof of rollback and the exchange is not replayed. Browser
navigation and Cookie behavior are owned by the separate HTTP integration.
