# Agent Note: API OAuth User WebSocket

Status: implemented

## Problem

An application browser needs a revocable user Session subscription tied to its
actual OAuth family and current resource permissions. Browser WebSocket APIs
cannot supply an Authorization header. Session subscriptions may outlive an
access token, and protocol negotiation must not echo an authentication secret.
Expiry and revocation handling must preserve the existing connection and viewer
lease cleanup responsibilities.

## Decision

Task user channels support their actual v1/v2 Session protocol and Test user
channels support v1. Each application handshake offers exactly one supported
Session protocol and one `daynight.authorization.<accessToken>` marker. The
adapter removes the marker before version selection and WebSocket acceptance;
only the Session protocol is negotiated and echoed. The explicit marker selects
API authentication independently of browser Cookies. Ambiguous carrier input
fails before authentication. Controller and Worker producer channels retain
their original credential paths. The
[authentication design](../../../../docs/design/daynight-auth.md#应用用户-websocket)
owns exact paths, error classification and secret handling.

A narrow application OAuth authentication operation validates the real fixed API
binding and returns the true user/access Principal, grant UUID and effective
access/grant expiry. The exact application Origin comes from validated server
configuration. Existing Session user purposes retain current resource, owner,
project permission, parent PAT and execution-fence checks. This extends the
[fixed family decision](2026-11-12-api-oauth-family.md) and shares the configured
Origin with the [CORS decision](2026-11-12-api-cors.md), while their adapters
retain separate responsibilities.

Each API socket installs the authenticated effective expiry as a deadline within
the existing connection cancel, CloseRead, poll and cleanup ownership. The
original 250ms poll reauthorizes the full family and current permission at its
existing Session purpose. Expiry or an observed authorization loss stops new
protected IO and publication. Refresh does not extend an existing socket or
change a persisted operation Actor; a new access reconnects through the original
fence, lease and resume rules.

API user connections select status 1008 with a fixed nonsecret reason for
authorization loss, 1011 for infrastructure failure, and 1001 when Routes is
closing. An expected `reset_required` retains its original control-frame and cleanup
path. Every close frame is
best effort: CloseRead cancellation, shutdown cancellation followed by CloseNow,
or IO failure may already have closed the transport. Existing native and
producer close ownership remains unchanged. The library's five-second close
write, five-second peer wait and possible fifteen-second goroutine drain remain
individual phase bounds. Original reservations, viewer identity release and
handler draining keep one owner.

## Alternatives

**Carry the token in a URL or frame.** URLs expose secrets to request targets and
logs. A frame permits protocol upgrade before authentication and requires a new
unauthenticated connection state. The subprotocol marker authenticates before
upgrade while the adapter prevents secret negotiation.

**Use the browser Cookie when the marker fails.** This would turn an explicitly
selected invalid application credential into a different native identity and
make the application's authentication outcome dependent on ambient login state.

**Rely only on the polling interval for expiry.** Polling observes current family
and permissions but cannot bound a protected IO wait to the socket's original
access expiry. The connection deadline supplies cancellation without changing
polling's authorization responsibilities.

**Introduce a second transport owner or a total five-second close guarantee.**
A second owner would compete with CloseRead and existing cleanup. A total bound
would misstate the library's separate write, peer-wait and drain phases and would
require a replacement shutdown protocol.

## Consequences

Application subscriptions keep the original user identity and Session protocol.
Authentication secrets are excluded from negotiated protocol output. The family
and current permission remain authoritative rather than a cached grant of
connection-wide business access.

Revocation takes effect when the existing poll observes it; it is not an atomic
notification at the instant of database change. Previously admitted transfers
retain their original bounded completion and cancellation semantics, and bytes
already sent cannot be recalled. A peer may observe disconnection without a
close frame after expiry or transport failure. A refreshed access must establish
its own authorized connection and cannot revive an expired Actor or migrate a
control lease.

Public REST API credential admission, S2S issuance and public API refresh/revoke
remain separate entry capabilities. HTTP/raw WebSocket tests own parsing,
negotiation, authentication branches, deadlines, polling and connection cleanup;
service/family tests own actual binding, expiry and transaction facts. Normal
assembled collaboration remains in the existing integration entry.
