# Agent Note: Worker Read-Only Transport Fixtures

Status: implemented

## Problem

The read-only WebSocket tests created PostgreSQL users, credentials and a
Worker report to obtain a valid transport peer. The raw TCP tests used the
same setup for requests whose incomplete bodies timed out or were refused
by the HTTP adapter. Each setup repeated identity and Worker initialization
for fixed credentials and targets.

## Decision

Controlled credential and Worker facts initialize the real HTTP adapter.
The WebSocket tests run the real Broker and exercise channel connects,
frames, deadlines, heartbeat, cancellation and result delivery. Cross-owner
requests pass through the actual credential parser and Broker.

The raw TCP tests use the same listener, routes and credential parser.
They send incomplete requests to exercise HTTP body deadlines, input
refusals and capacity refusals. A strict Broker substitute fails on Worker
operations, so the tests verify that refusal occurs before Worker dispatch.

Physical coverage remains for login and credential revocation during a live
channel, stored Worker freshness and owner visibility, and the tagged native
Worker proof. That coverage uses actual PostgreSQL and identity credentials.

## Alternatives

**Keep the database and login for every transport peer.** This repeats a
full service setup before exercising the channel, while only some cases
need actual credential changes or persisted Worker reports.

**Substitute the socket or the channel Broker.** A socket substitute would
lose the native body deadline and connection close observations. A Broker
substitute in the WebSocket cases would lose channel routing and cancellation
behavior.

## Consequences

The selected transport and HTTP refusal tests run without PostgreSQL or
UniAuth. The database-backed revocation and native cases use their existing
fixture and cleanup.
