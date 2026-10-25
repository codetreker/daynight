# Agent Note: Default Service and Explicit CLI Device Login

Status: implemented

## Problem

A production CLI user must configure a server origin that is already known, then
create a personal access token in the browser and transfer it to the terminal.
That setup makes a routine account login depend on manual secret handling.
A test-server override and unattended credentials still need to remain available,
with the origin isolation and concurrency guarantees of the existing configuration.

## Decision

Service configuration defaults to `https://daynight.cc` when its file or
`serverUrl` field is absent. An explicit origin is a test-server override and
retains strict validation. Ordinary setup collects review configuration;
`--server-url` and `--server-token-stdin` remain explicit noninteractive options.
A missing local credential fails before business dispatch and points to
`daynight login`; a server 401 gives the same guidance. Business commands do not
start authorization or replay writes.

`daynight login [--no-browser]` starts a Daynight-owned device authorization using
the existing browser session and UniAuth login. The browser shows the current
account and human code, requires code comparison and an explicit approval or
rejection, and never approves during navigation or login. Device endpoints follow
[RFC 8628](https://www.rfc-editor.org/rfc/rfc8628); the public CLI contains no App
Secret. Login has its own ten-minute deadline and cancellation, separate from
business-operation budgets.

The device grant is a new authorization method for the existing PAT credential
store. Approval binds the browser's account. A locked transaction consumes that
grant and creates one `Daynight CLI` credential with no expiration. The account
token manager exposes its metadata, editable expiration and revocation. Both CLI
and manually created PATs default to never expiring, so unattended commands keep
access until the owner chooses an expiration or revokes it. A future expiry can
be set or cleared later without replacing the token secret. Edits require a
current browser session, the displayed account and the observed expiry; expired
or revoked credentials cannot be revived. The server stores only device and
credential secret hashes. Concurrent redemption cannot issue two credentials,
and a lost successful response requires a fresh login; the orphaned credential
can be revoked from the account list. No refresh token or new credential kind is
introduced.

Short codes have ten consonants and creation/lookup limits persist in PostgreSQL
across replicas. Poll timing and slow-down state persist with the grant. Expired
grant records remain for one hour before bounded cleanup, allowing
a browser with an uncertain decision response to inspect the actual state.
A decided grant is inspectable only by its deciding account. Browser inspection
and decision require a current session plus exact Origin; ordinary PATs cannot
approve devices. A decision also carries the displayed account's `expectedUserId`;
the server compares it with the current Cookie principal before mutation, so an
account change cannot approve under an account the page did not display.

Credential saves reuse the existing YAML write lock, atomic replacement and
POSIX `0600`. Login rechecks its origin and credential observation under that
lock. `daynight logout` revokes only the current Bearer credential, then clears
the observed local value after confirmation or an already-invalid response.
Neither operation can overwrite a concurrent login or origin change. Network
and uncertain failures remain explicit.

This partially supersedes the manual-only issuance and setup guidance in the
[CLI credential decision](2026-10-22-cli-server-credentials.md) and the server
initialization branch of the
[configuration decision](../feature/2026-10-21-guided-configuration-setup.md).
Their safe persistence, independent capability projections, no-secret diagnostics
and origin ownership remain. The
[authentication design](../../../../docs/design/daynight-auth.md#cli-设备授权)
owns endpoint, data and interaction contracts.

## Alternatives

**Keep manual PAT provisioning as the normal login.** It preserves the existing
workflow but still requires every interactive user to create and transfer a
secret. Explicit stdin PAT configuration remains useful for unattended jobs.

**Authorize automatically after a failed business command.** It can reduce one
terminal command, but makes ordinary reads or writes initiate browser work and
complicates noninteractive behavior and uncertain writes. Explicit login follows
the user-initiated model in RFC 8628 section 3.1.

**Add a separate device credential and refresh-token lifecycle.** It enables
independent device-session policy, but requires another credential table,
authentication path and account-management model. Existing revocable PATs with
optional expiry already provide the requested access. Refresh for a public client would
also require rotation or sender constraint under
[RFC 9700](https://www.rfc-editor.org/rfc/rfc9700#section-2.2.2). A separate lifecycle
can be added when its product semantics are needed; the authorization method is
kept separate from business authentication.

**Extend UniAuth into a downstream device issuer.** UniAuth provides a
confidential-backend identity handoff. Daynight already owns users, browser
sessions, project membership and credentials, so device approval belongs at that
existing application boundary.

## Consequences

Production service selection needs no configuration. Interactive access uses an
explicit login/logout pair, while test-server overrides and scripted PAT use
retain their existing purpose. Current project membership remains authoritative
for every business request; a credential does not freeze roles or membership.

The application gains short-lived authorization state and persistent rate
windows, with bounded cleanup and shared limits. A consumed response cannot be
replayed because plaintext credentials are not retained. Users repeat login after
a lost successful exchange, revocation or a configured expiration. Changing an
active credential's expiration preserves its secret and the saved CLI login.
Browser sessions retain their independent seven-day lifetime; browser logout
remains separate from CLI logout, and neither silently revokes the other's credential.

Changing the origin still clears the old local token atomically. The remote
credential remains revocable through the account list if origin changes or local
write failure prevent a later CLI logout. Runtime and platform acceptance remain
source-bound evidence rather than a claim made by this decision record.
