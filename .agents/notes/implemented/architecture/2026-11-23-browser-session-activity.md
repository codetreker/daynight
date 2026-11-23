# Agent Note: Browser Session Activity

Status: implemented

## Problem

A browser used throughout a week reaches the same fixed expiration as an idle
browser. Main-site and isolated preview credentials already share a session;
independent renewal would break their common expiry and revocation. Waiting for
a database lock must not let an expired credential authorize a later renewal.

## Decision

Browser sessions have one 168-hour idle deadline based on the primary database
clock. Renewal locks the existing row by the actual credential hash, then reads
the clock, checks current validity and monotonically updates activity and expiry.
Only a confirmed transaction exposes success. Session issuance, authentication,
preview SSO, permission rechecks and cleanup use that clock; PAT and OAuth retain
their own contracts. The nullable activity column preserves unknown historical
use without backfill.

Main-site activity is admitted only at registered application authentication
entries with the configured authority and consistent same-origin evidence.
Method-qualified registrations declare business methods directly. Internal
dispatchers declare their supported business methods, including supported HEAD,
through a private request role before authentication. Their existing method
tables own this declaration; unsupported methods cannot inherit an outer
dispatcher's admission. Undeclared methods carry the refusal role even when a
qualified GET registration would otherwise imply HEAD. The Session history
collection therefore preserves its protocol refusals without renewing authority.
Assistant Task, Bot detail, Webhook and OAuth consent
therefore share the same activity contract as directly registered handlers.
Registered method refusals carry a separate request role and remain read-only,
including qualified refusals that shadow wildcard business routes.
Their authentication, policy and CSRF checks keep the same ordering.
Cookie writes require the exact Origin independently of Fetch Metadata. A shared
Origin check excludes invalid writes before renewal while the read-only path
keeps authentication refusal ahead of CSRF refusal; metadata-only safe reads
remain eligible.
Preview activity follows protected content authorization and rechecks the
original preview hash, with a constrained request-source matrix. The explicit
activity API binds the intended account before writing. The
[authentication design](../../../../docs/design/daynight-auth.md#主站-session-与-pat)
owns the full admission and transaction contract. The
[preview identity decision](2026-11-16-preview-sso-identity.md) continues to own
the separate credential and atomic one-time exchange.

Newly issued Cookies request 400-day persistence; routine renewal never changes
the browser credential or its Cookie. Old Cookies retain their original expiry.
The original [credential decision](../../archived/architecture/2026-10-22-identity-credentials.md)
records the fixed session deadline that preceded activity-based expiry.

## Alternatives

**Renew while authenticating every request.** Generic authentication also serves
public navigation, SSO steps, rejected methods and automatic cross-origin traffic.
It would let those requests prolong browser authority without application use.

**Infer business activity solely from a method-qualified route pattern.**
Qualified GET, PATCH and DELETE refusals prevent a reserved action path from
matching a wildcard resource handler. Such patterns identify the selected
method but cannot distinguish business use from a registered refusal. Conversely,
internal business dispatchers have no method-qualified mux pattern. Explicit
request roles must declare both supported methods and pure refusals before the
authentication write; the route pattern alone cannot own this distinction.

**Choose the timestamp before acquiring the row lock.** A request can wait until
after the stored deadline and still revive the row using its stale timestamp.
Locking the actual credential before reading the database clock prevents this.

**Reissue Cookies on each request.** Concurrent responses can overwrite browser
credentials, and previews would need coordinated Cookie writes across isolated
domains. Long-lived issuance separates browser retention from server authority.

## Consequences

Expired, deleted and rotated credentials cannot revive sessions. Admitted
background reads and 304 responses extend the same row used by preview access.
Each eligible request writes the row and its expiry index, with lock contention
and WAL cost under concurrent polling; independent load evidence owns measured
results. The browser may clear Cookies earlier than their requested retention,
requiring normal login or preview SSO even when the server row remains valid.
Deployment must drain older authentication writers before switching both domains
to the new clock and renewal contract.
