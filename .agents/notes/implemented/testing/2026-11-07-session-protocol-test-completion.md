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

Grant and durable event-cursor refusals remain in their failure test. The
existing source-reset recovery test checks the Controller's opaque cursor
request and explicit `reset_required` response, including removal of the
completed content request. A caller deadline or offline-Controller error cannot
satisfy that assertion. The
[Session design](../../../../docs/design/task-session-protocol.md#本机内容与在线读取)
owns live-content responsibility and its request bounds; the
[original local-content decision](../../archived/architecture/2026-10-28-local-session-content.md)
records why server-owned history cursors were replaced.

The terminal test keeps its Worker owner and uses a separate Project member as
the browser viewer. Removing that member's grant revokes its effective access
without changing personal-Team ownership. An HTTP refusal and socket closure
before the caller deadline establish the transition, while the Worker's owner
retains access. Fixture shutdown selects only the expected clean `forbidden`
drain error through the existing
[shutdown matcher](2026-11-07-session-deletion-shutdown-expectations.md).

The browser ping case uses real business services, authentication and production
Session routes in a focused route fixture. A constructor compiled only for
tests configures the existing private interval. Other HTTP scenarios retain
the complete application fixture. Route cleanup drains the relay and stops
its engine before the outer fixture releases the borrowed Store and files.
The [HTTP ownership decision](2026-11-06-server-http-proof-owners.md) and
[validation guide](../../../../packages/daynight-server/README.md#http-scenario-ownership)
own that distinction.

## Alternatives

**Add a separate Timeline integration fixture.** The recovery scenario already
performs the required online read and Controller response. Strengthening that
case avoids another schema, identity and connection setup.

**Expose runtime ping configuration through application assembly.** A public
constructor or configuration hook would add production API solely for this
adapter test. A focused test fixture reaches the existing private interval
without extending the runtime configuration contract.

**Accept a socket error from the original owner after removing its grant.**
Owning-Team authority remains valid, so the test would still succeed through
its caller deadline. A separately authorized viewer makes the intended access
transition explicit.

## Consequences

These scenarios complete through Controller responses, effective permission
revocation and an observed Ping/Pong exchange. Production content and ping
intervals retain their existing values. The ping fixture exercises protocol
behavior directly; complete-application scenarios continue to cover assembly
and endpoints outside the Session adapter. Actual command and CI timing results
remain source-bound validation artifacts.
