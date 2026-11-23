# Agent Note: Public API Application Authorization

Status: implemented

## Problem

A trusted application needs to obtain independently revocable authority for a
real user's ordinary Daynight API operations. The owner needs to see and revoke
that application in the existing authorization list. Issuance must not create
partial accounts, return secrets after uncertain commits, or turn the
application into a native account administrator or runtime producer.

## Decision

The fixed [API OAuth family](2026-11-12-api-oauth-family.md) is publicly admitted
through narrow HTTP adapters. Trusted S2S issuance validates its configured
shared key and strict external-user input before invoking user initialization.
The service first confirms a complete user and Personal Team, then issues an
independent API family. A family failure may retain a complete initialized
account; neither phase invents a rollback result after an unknown commit.

The optional key is loaded at startup, validated as 32–256 visible ASCII bytes,
and compared in constant time. Empty disables only issuance. YAML and environment
overrides preserve absent, empty and nonempty settings, including both Compose
templates. Key replacement requires restart and does not revoke existing
families. The separate exact application Origin controls browser REST CORS and
user WebSocket admission, without exposing the S2S issuer to browser CORS.

REST authentication adds only the fixed API token dispatch. Explicit
Authorization precedence and rejection without Cookie fallback remain. The
same application OAuth instance supplies REST, user WebSocket and readonly
checks. Existing business services keep current user permissions, versions,
transaction boundaries and resource lifetimes. Native account operations,
browser/device consent, PAT management and Worker/Controller producer
credentials retain their original admission rules.

Public refresh and self-revoke recognize the fixed API profile through the
existing family lifecycle. The DAO normalizes its fresh database clock to UTC
microseconds before rotation computes or persists deadlines. Driver scan
locations therefore cannot change the required UTC token-response representation,
and the returned deadlines retain the actual post-lock issuing instant. API
refresh uses the public client's existing no-secret authentication, without
another S2S key. Authorization-code exchange
remains MCP-only. API issuance and refresh share an exact token response; MCP
retains its original response. Secrets are encoded only after confirmed commit.
The owner reads the real application and rolling deadline and revokes through
the existing native-session authorization endpoints.

Successful HTTP API authentication, including the user WebSocket marker branch,
records one real grant usage event. Refresh records only its confirmed rotation
candidate through the existing recorder. Issuance, polls and internal rechecks
do not create usage. Recorder faults do not change authentication, business or
refresh outcomes. Existing drain and dependency-release ordering remains.

The [authentication requirements](../../../../docs/spec/daynight-auth.md#用户应用授权-api)
own exact inputs, response fields, deadlines and failures. The
[authentication design](../../../../docs/design/daynight-auth.md#oauth-family-的固定-profile-与-api-授权)
owns assembly and transaction mechanisms.

Normal API integration obtains the public S2S grant and reads the same
Goal/Task, Step, Thread and protected attachment records through application and
native access. The readonly HTTP requester uses that API grant while its Worker
producer retains a PAT. Webhook management follows a disabled endpoint through
subscription, operation, signing-key and tombstone readbacks. Disabled capture
keeps the production destination transport inactive; the existing real transport
and lifecycle mechanism tests own delivery and payload guarantees. This split
proves public assembly without relaxing the public-address restriction or
contacting an external receiver.

## Alternatives

**Issue a browser session or PAT.** Those credentials mix the application's
independent authority with native account operations and do not provide the
selected application family, rolling refresh and owner revocation semantics.

**Replace business authorization across domains.** The current user principal,
credential readers and domain permission checks already enforce the required
authority. A general framework would move locks and transactions unrelated to
public token admission and duplicate the existing rules.

**Recover plaintext after a lost response.** Only hashes are persisted. Retaining
replayable secrets or introducing general operation-result recovery would add a
separate storage and protocol contract. Explicit duplicate applications may
create another family; failed refresh does not automatically reissue one.

## Consequences

Applications can use ordinary user REST and supported user Session channels with
an independently visible family. A user can explicitly reconnect after revoke
with a new grant ID. Revocation does not delete existing resources or cancel
already dispatched work; future admission still checks the current family and
permissions. Existing admitted transfer boundaries remain.

A confirmed commit can outlive a lost response, and its plaintext cannot be
recovered. A full account can remain after later issuance failure. API clients
must preserve unknown outcomes and manage refresh concurrency; no consumer UI,
cache, preview proxy or automatic reconnection policy is implemented here.
