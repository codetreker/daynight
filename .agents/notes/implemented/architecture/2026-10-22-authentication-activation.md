# Agent Note: Mandatory Authentication Composition

Status: implemented

## Problem

Identity, membership, CLI credentials and the authenticated Web shell were built
independently to avoid exposing partially protected resources. Keeping those
modules unmounted no longer serves users who need per-project access. Activation
must cover every resource route, required configuration, production Web entry,
health check and real-service acceptance caller together, while preserving
attachment execution, transaction ownership and the existing validation workload.
Registered callbacks and HTTP test origins also need explicit runtime values
rather than assumptions embedded in a handler.

## Decision

`server.New(Dependencies, Config, logger)` validates configuration, constructs the
pinned UniAuth client, and mounts authentication, membership and all existing
resource routes. It returns a handler or an error. Startup propagates composition
failure and closes its acquired listener, file root and database. Resource use
cases accept an explicit `core.Principal`; ordinary project creation atomically
adds its first administrator and ordinary project lists filter membership before
pagination. The staging aliases `CreatePrivate` and `ListAccessible` are removed.
There is no anonymous business mode, fixed user or trusted-principal adapter.
The [status assignment decision](2026-10-24-task-status-assignment.md) uses the
same Principal for SetStatus, checks membership after the project lock, and then
validates exact version, target and dependencies. Member/admin task-write rights
remain equal. Create defaults to todo, metadata PATCH rejects status and the
status PUT/405 paths retain Require, Cookie Origin and no-store handling.

Production `main.tsx` mounts a reactive application entry under the persistent
`LocaleProvider`. The [public product entry decision](2026-10-26-public-product-entry.md)
owns public introduction and guide selection; `AuthenticatedApp` owns explicit
login and protected pages. Existing task and attachment tabs, progressive task graphs,
bilingual presentation, centered detail dialogs and browsing formats retain their
own state and behavior. TaskDetailSessionProvider lives inside the current
identity/generation boundary, preserving pending task status/permission writes across dialog
close/reopen while discarding its state on an account change. This note describes the implemented composition; passing
current-source gates, combined acceptance and real-provider login require their
own receipts. The [requirements](../../../../docs/spec/daynight-auth.md) and
[design](../../../../docs/design/daynight-auth.md) own the complete behavior.

### Required configuration and upstream discovery

The public SDK is pinned to
`github.com/codetreker/uniauth/sdk/go v0.0.0-20261022095215-0978963813fc`, with the
real fixture using the same
[upstream revision](https://github.com/codetreker/uniauth/tree/0978963813fcefd9d553f6cb9bcc319084c764b3).
Public `GET /api/v1/auth/providers` calls the authoritative App-aware SDK method
with the registered callback. Empty results remain valid. App configuration or
credential failures map to 503, upstream network/protocol failures to 502, and
timeout to 504; they do not masquerade as the caller's session 401.

Five values are mandatory: `DAYNIGHT_PUBLIC_ORIGIN`, `DAYNIGHT_UNIAUTH_URL`,
`DAYNIGHT_UNIAUTH_APP_ID`, `DAYNIGHT_UNIAUTH_APP_SECRET` and
`DAYNIGHT_UNIAUTH_CALLBACK_URL`. Secrets remain server-side. The main origin is
canonical and explicit; the callback uses that exact origin with a query-free,
canonical non-root path such as `/auth/callback`. Only its configured route is
registered. Startup rejects owned-route collisions and encoded aliases; login
rejects an auth/callback return loop before storing pending state. There is no
old callback alias or request-derived origin.

Main-site HTTP testing and SDK gateway HTTP are separate choices.
`DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN=1` permits an explicitly configured HTTP main
origin and chooses its HTTP test cookie policy. It does not call a named host
loopback. `DAYNIGHT_ALLOW_LOOPBACK_HTTP=1` enables only the SDK's literal
localhost/numeric-loopback gateway exception. Each switch otherwise defaults to
off and accepts only 0 or 1. A normal HTTPS main site can use an explicitly
allowed loopback HTTP gateway. The Go listener still binds numeric loopback.
`/healthz` and `/readyz` are public and expose no business data; readiness checks
the database rather than the project list or the upstream identity provider.

### Admission and unchanged attachment behavior

HTTP authentication looks up the current session/PAT for each request and forms
its Principal. Resource services check current membership inside their existing
Snapshot or project write lock. These are distinct admission points; this change
does not serialize credential revocation with every business transaction.
Attachment membership, task and path checks finish in a short snapshot before
file IO. An admitted operation may finish after membership or credentials change;
new requests authenticate and authorize again. No post-IO membership recheck is
added, and filesystem/PostgreSQL non-atomicity remains K1.

Trusted executable HTML stays at the application origin with the viewer's
ordinary session authority, relative resources and existing keyboard bridge.
The [architecture decision](2026-10-22-auth-architecture.md) and
[attachment decision](2026-10-21-task-attachment-storage-design.md) retain the
explicit exclusion of preview domains, scoped preview credentials and gateway
infrastructure. Existing projects remain unassigned until manual membership
maintenance; no legacy data branch is added.

### Real protocol fixtures and private runtime state

Acceptance uses one pinned real UniAuth fixture executable and normal browser
handoff to obtain sessions and PATs. Only the external provider HTTP responses
are controlled. Targets own independent App/SQLite/port/session state; they do
not insert Daynight users, tokens or memberships to bypass the protocol.
The Go `testing.T` bootstrap helper lives under `testdata/testauth` and is
imported only by tests, keeping it outside production packages. The preparer builds `CGO_ENABLED=0` native or architecture-specific Linux binaries
and binds caches to target, source, toolchain and output hashes. Node.js 24's
built-in SQLite `BEGIN IMMEDIATE` serializes shared preparation across processes,
including checkout, source installation and binary replacement.

Private 0600 handoff files, CLI homes, UniAuth data and auth environment files
remain outside uploaded receipt roots. Receipts keep public origins, source and
binary identities, process ownership, phase outcomes and cleanup. The native
runner owns its fixture lifecycle. Dev-ci stages gateway/PostgreSQL, discovered
main port, a real UniAuth sidecar in the gateway namespace, private auth config,
then server readiness. The same loopback U port is reachable by the host browser
and in-namespace SDK. Reconfiguration after recreation updates the exact callback;
bootstrap permits restoring SQL/files before starting Daynight. Private UniAuth
state is run-owned fixture data, not a third Daynight backup volume. Cleanup
removes credentials; a failed cleanup preserves only the private state needed
for targeted recovery and reports failure.

The [localhost guide](../../../../deployment/localhost/README.md) owns private
`.env` preparation. The [dev-ci guide](../../../../deployment/dev-ci/README.md)
owns toolchains, Linux fixture architecture, reconfiguration and recovery.
An optional Vite callback proxy uses the same callback setting and existing Go
API target, matching only the exact path while preserving query bytes; unset
frontend-only mockups remain independent.

### Browser evidence privacy

Playwright `playwright-core` 1.64.1 records raw credential-bearing traffic in its
action/network trace. The versioned
[package archive](https://registry.npmjs.org/playwright-core/-/playwright-core-1.64.1.tgz)
and the integrity in [pnpm-lock.yaml](../../../../pnpm-lock.yaml) identify the
inspected source. In that package's `lib/coreBundle.js`, HarTracer is constructed
with `content: 'attach'` near line 26868. API request headers are copied near
26186, raw response headers near 26210–26217, browser request headers near 26271,
response body attachments near 26310–26325, and whole resource snapshots near
27308–27310. These paths can preserve Authorization, Cookie, Set-Cookie and token
response bodies. `omitCookies` changes parsed cookie arrays; raw headers still
remain. This is a package-level observation, not a claim that trace defaults
redact credentials.

The ordinary Playwright trace and capacity override are therefore off. Secret
screens are captured only after closing or masking the one-time value. Existing
PNG/compositor oracles, custom CDP timing/frame/GC diagnostics, all assertions,
raw report validators, capacity inputs, deadlines and resource budgets remain.
The cost is loss of Playwright action/network trace replay on failures. The
narrow authenticated Playwright API wrapper replaces request and response-reading
failures with safe operation/method/path/category/status/request-ID metadata;
raw Playwright error text and causes cannot carry credential call logs into
receipts. Invitation fragment assertions compare booleans rather than exposing
the secret as an assertion value. Private protocol diagnostics and safe
structured errors provide narrower investigation
without uploading credential traffic or introducing a general artifact-redaction
framework.

## Alternatives

**Mount only login or only some resources.** The independently composed modules
made earlier review possible, but partial production mounting would leave mixed
access paths or require a bypass. All business routes and acceptance callers now
move together, as required by the original architecture.

**Keep the fixed callback or derive it from Host/listener.** A fixed internal path
cannot match an explicitly registered custom callback. Request-derived addresses
also confuse the public origin with the loopback listener. Required exact config
makes registration, routing and return-loop rejection share one value.

**Use one insecure HTTP option.** Main-site cookie transport and the SDK gateway
are different origins with different validation rules. Separate explicit options
permit controlled tests while retaining the SDK's literal-loopback restriction.

**Retain traces and redact only known cookie fields.** Raw headers, attached
bodies and resource snapshots contain credentials outside parsed cookie arrays.
A complete postprocessing framework would have to track every artifact encoding
and future package change. Disabling that credential-bearing capture preserves
the required behavioral and performance evidence with a clear diagnostic cost.

## Consequences

The earlier [identity](2026-10-22-identity-credentials.md),
[membership](2026-10-22-project-membership.md),
[CLI credential](2026-10-22-cli-server-credentials.md) and
[Web workspace](../feature/2026-10-22-web-auth-workspace.md) records preserve why
components were first delivered separately. This note supersedes their unmounted
runtime status, fixed callback and loopback-only main-test assumption. Their
identity, role, invite, exact-version, secret-input and trusted attachment rules
continue to apply.

Deployment now requires real App configuration and every fixture must acquire
credentials through the protocol. Current-source validation must cover missing
config, wrong origins, credential and membership revocation, direct resources,
provider failures, last-admin/invitation concurrency and complete native/container
journeys. The [combined authentication decision](../testing/2026-10-23-authentication-combined-acceptance.md)
composes normal browser and installed-CLI authority across service restart,
revocation during admitted IO and actual socket loss. It also owns real UniAuth
result consumption followed by downstream TCP loss. Its two additional target
receipts preserve the existing Playwright inventory and budgets. Source receipts
and third-party manual login evidence remain distinct; a code or documentation
change does not itself establish a passing run.
