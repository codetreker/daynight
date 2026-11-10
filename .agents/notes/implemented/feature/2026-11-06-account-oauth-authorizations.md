# Agent Note: Account OAuth Authorizations

Status: implemented

## Problem

An account owner needs to inspect and revoke a single application's OAuth
authorization without confusing it with personal access tokens or assuming that
a lost revocation response proves what happened.

## Decision

The account credentials page lists owner grants and lets the owner revoke an
active grant after confirming the account, client and resource. Session-only
HTTP adapters call the existing grant lifecycle, with exact Origin and expected
account checks for writes. The session is rechecked in the transaction after
lock waits. A revoked family loses both access and refresh credentials. The
page retains PAT management independently and records a secret-free, account-bound
recovery marker before dispatch. An unconfirmed revocation requires an explicit
current-state read, including after navigation or reload. The
[authentication design](../../../../docs/design/daynight-auth.md#主站-session-与-pat)
owns the endpoint and UI contract.

## Alternatives

**Automatically retry an uncertain revocation.** A lost response can follow a
committed write, so retrying would hide the original outcome and present a later
observation as its receipt. A user-directed read supplies current facts instead.

## Consequences

The owner can distinguish active, expired and revoked grants without exposing
secrets. A current-state read cannot reconstruct a lost response. Grant metadata
retention follows the lifecycle policy, so an absent grant does not establish a
historical revocation result. OAuth grants have no PAT expiry editor.
Browser session storage is required to dispatch a revocation so an interrupted
page cannot silently discard its recovery responsibility.
