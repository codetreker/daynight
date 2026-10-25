# Agent Note: Origin-bound CLI Server Credentials

Status: implemented

## Problem

An unattended client needs to supply a personal token without exposing it in
arguments, prompts or diagnostics. Reconfiguring a service must not send a
previous service's credential to a different origin. Configuration contains a
secret, so parser diagnostics and persistence permissions need explicit ownership
as well as the HTTP transport.

## Decision

The server projection uses optional `serverToken`, an opaque visible-ASCII
credential restricted to HTTPS or literal localhost/numeric-loopback HTTP.
Review and unrelated commands retain independent configuration projections.
The shared HTTP client attaches Bearer to its existing requests while retaining
manual redirects, request/operation/response budgets, pagination, exact versions
and binary stdout. Credentials remain outside repository bindings.

The origin and token observation are checked together under the existing write
lock; changing the normalized origin clears the old credential atomically.
Unrelated completed review changes are preserved. The shared configuration writer
restricts credential-bearing files to POSIX `0600`, including other capability
writes; files without a token retain the existing permission behavior. The lock,
regular-file/symlink checks and atomic replacement remain.

Strict YAML diagnostics retain safe category, code and offsets because raw
alias/tag/key errors can contain scalar values. Raw parser text and nested parser
causes do not enter error objects; other failures retain their useful chains.
The generic formatter and HTTP errors are not a general redaction framework.

The original credential delivery used hidden terminal input for interactive
server setup and a boolean `--server-token-stdin` for scripts. It accepted one
nonempty line with an optional LF/CRLF, and a blank hidden answer preserved a
same-origin token or skipped a new origin's token. A single terminal reader owned
input: ordinary readline closed with its internal cleanup before the hidden
prompt, and only application-owned listeners were removed. Real PTY transcripts
verified secret characters did not echo and cancellation saved no partial input.
Those observations describe that delivery's input path.

The [device-login decision](2026-10-25-cli-device-login.md) replaces normal manual
provisioning with explicit login/logout and removes interactive server setup.
The stdin path remains for automation and uses the configured or default service.
Missing local credentials and server 401s now point to `daynight login`, without
anonymous fallback or business mutation replay. The
[identity foundation](2026-10-22-identity-credentials.md) owns ordinary credential
lookup; the [authentication design](../../../../docs/design/daynight-auth.md)
owns device issuance, revocation and the trusted same-origin attachment model.

## Alternatives

**Plain token command-line option.** It exposes a secret in shell history and
process arguments. The original hidden prompt and retained stdin path avoid
that exposure; current device login also avoids manual secret transfer.

**Implement a CLI provider-login flow at original delivery.** The selected
product model then used Web-created PATs, while UniAuth supplied a confidential
backend handoff. A new credential lifecycle did not serve that scope. The later
device-login decision changes the user workflow by reusing the same credential
lifecycle and browser identity boundary.

**Keep a credential when switching service origins.** The next request could
send it to a different service. Clearing the old token in the origin update's
same atomic write preserves ownership.

**Propagate raw YAML errors or redact only their top-level message.** Nested
messages can still contain scalars, and formatters traverse causes. Safe errors
at the credential boundary preserve failure category and location without
copying values into error objects.

## Consequences

One origin-bound credential stays in the existing YAML format, without a registry,
keychain or project-local secret. Configuration may omit it; business commands
then fail locally with login guidance. Mandatory server authentication still
rejects missing, invalid, expired or revoked credentials. Device authorization
changes acquisition while retaining this transport and persistence model.

The original installed-client evidence paired normal UniAuth/session-to-PAT
bootstrap with stdin setup, project creation/filtered listing and revocation.
Platform terminal and shell checks were separate evidence. Those historical
results do not establish current-source login or platform acceptance.

Explicit origin replacement still validates the previously stored origin before
saving. An invalid old value therefore requires manual repair. Fail-fast locking
also leaves abnormal lock recovery to the operator after confirming no writer is
running.
