# Agent Note: Worker Read-Only Transport Fixtures

Status: implemented

## Problem

The read-only WebSocket tests create PostgreSQL users, credentials and a Worker
report to obtain a valid transport peer. The assertions concern admission,
channel routing and the behavior of the live Broker and HTTP adapter.

## Decision

Controlled credential and Worker facts initialize the real HTTP adapter and
Broker. The transport tests retain actual WebSocket connects, frames,
deadlines, heartbeat, cancellation, and result delivery. A cross-owner
request still passes through the actual credential parser and Broker.

Physical coverage remains for login and credential revocation during a live
channel, stored Worker freshness and owner visibility, and the tagged native
Worker proof. That coverage uses actual PostgreSQL and identity credentials.

## Alternatives

**Keep the database and login for every transport peer.** This repeats a
full service setup before exercising the channel, while only some cases
need actual credential changes or persisted Worker reports.

**Substitute the channel or Broker.** That would remove the handshake,
cancellation and frame behavior these tests verify.

## Consequences

The selected transport tests run without PostgreSQL or UniAuth. The
database-backed revocation and native cases continue to use their existing
fixture and cleanup.
