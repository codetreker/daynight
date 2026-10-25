# Agent Note: Machine Names in CLI Credentials

Status: implemented

## Problem

Credentials from multiple CLI installations have the same display name, making
it difficult to identify which machine's access should be revoked or given an
expiration in the account token manager. Browser approval can happen on a
different machine from the terminal that receives the credential.

## Decision

The CLI reads `node:os.hostname()` once before starting device authorization and
sends that value as required `device_name` on every token poll. Lookup failures
propagate. The server accepts valid UTF-8 containing 1–255 Unicode characters,
requires a nonblank value without control characters, and rejects missing or
invalid input with `invalid_request` before consuming the grant.

Redemption creates `Daynight CLI (<hostname>)`, retaining the first 85 Unicode
characters of the hostname so the complete name respects the existing
100-character PAT limit. Name construction belongs to the service; the generic
credential store retains its existing atomic consumption and insertion contract.
The machine name is display metadata supplied by the credential recipient, not
an authenticated machine identity or an approval input. It needs no field in the
device authorization record.

This replaces the uniform name established by the
[device-login decision](../architecture/2026-10-25-cli-device-login.md), retaining
its explicit approval, credential lifecycle and configuration guarantees.

## Alternatives

**Bind the machine name when creating the grant.** Persisting it with the grant
would support showing the same name during browser approval. Credential naming
alone needs the value only at redemption, so that approach adds stored state and
a migration without an additional required behavior.

## Consequences

The token manager identifies the initiating machine even when approval uses
another device. Names are descriptive and may repeat; they cannot authorize a
device or replace the code and account checks. Long names can share a truncated
display value. Existing credential names remain unchanged because their
originating hostname was never recorded.

CLI and server token requests share the required field contract and must be
updated together. Grant creation and browser approval retain their existing
formats. No secret, token lifetime, credential kind or database schema changes.
