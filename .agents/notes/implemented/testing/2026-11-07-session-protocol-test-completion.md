# Agent Note: Session Protocol Test Completion

Status: implemented

## Problem

A Timeline cursor test accepted any error after requesting content without a
Controller response. The live-content protocol delegates that cursor to the
Controller, so its request reached the content deadline without exercising
cursor rejection. A terminal subscription test removed its Worker's direct
Project grant while owning-Team membership still authorized the same identity;
its eventual caller deadline also satisfied an any-error assertion.

The browser ping regression used the complete application and waited for the
production ten-second interval. Its required observations are the Session
adapter's Ping/Pong exchange and later event delivery on the same connection.

## Decision

Tests distinguish grant and durable event-cursor refusals from live-content
cursor handling. The source-reset recovery scenario checks the Controller's
opaque cursor request and explicit `reset_required` response, including removal
of the completed content request. A caller deadline or offline-Controller error
cannot satisfy that assertion. The
[Session design](../../../../docs/design/task-session-protocol.md#本机内容与在线读取)
owns live-content responsibility and request bounds; the
[original local-content decision](../../archived/architecture/2026-10-28-local-session-content.md)
records why server-owned history cursors were replaced.

The original terminal correction kept the Worker owner and used a separate
Project member as browser viewer. Removing that member's grant revoked effective
access without changing personal-Team ownership. An HTTP refusal and socket
closure before the caller deadline established the transition while the Worker's
owner retained access. The current isolated adapter fixtures supply those
effective access results explicitly and retain the actual HTTP and socket
observations. Their cleanup uses the exact clean fault matcher described in the
[shutdown decision](2026-11-07-session-deletion-shutdown-expectations.md).

The initial ping correction used real business services, authentication and
production Session routes in a focused fixture. A constructor compiled only
for tests configured the private interval; other scenarios retained the full
application. Cleanup drained the relay and stopped its engine before the outer
fixture released its borrowed Store and files.

The [complete Session HTTP isolation decision](2026-11-09-server-session-test-dao-mocks.md)
replaces that fixture allocation. The regular package now assembles real Session
service, engine, authentication and routes with configured DAO facts. Test-local
ping construction still exercises actual Ping/Pong and subsequent events on the
same connection. Route draining, engine shutdown and mock completion retain
their separate lifecycle observations. The
[HTTP ownership decision](2026-11-06-server-http-proof-owners.md) and
[validation guide](../../../../packages/daynight-server/README.md#session-http-tests)
own the current scope and command.

## Alternatives

**Add a separate Timeline integration fixture.** The recovery scenario already
performs the online read and Controller response. Strengthening it avoided
another schema, identity and connection setup during the initial correction.

**Expose runtime ping configuration through application assembly.** A public
constructor or configuration hook would add production API solely for the
adapter test. Test-only construction reaches the private interval while
preserving the runtime configuration contract.

**Accept a socket error from the original owner after removing its grant.**
Owning-Team authority remains valid, so the test could still succeed through
its caller deadline. A separately authorized viewer establishes the intended
access transition.

## Consequences

The scenarios complete through Controller responses, effective permission
revocation and an observed Ping/Pong exchange. Production content and ping
intervals retain their existing values. Complete application composition and
Store mechanisms keep their own witnesses; the Session adapter suite retains
real transport with controlled dependency facts. Actual command and CI timing
results remain source-bound validation artifacts.
