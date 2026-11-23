# Agent Note: Bot Defaults HTTP Test Owners

Status: implemented

## Problem

The Bot defaults HTTP cases used separate PostgreSQL schemas and UniAuth
credentials for parsing, authentication and response projection. Some prepared
Worker facts only to prove a selected candidate, empty preview or refusal.
The over-capacity case inserted 101 Workers to obtain a stable error code.
The same tests also observed actual candidate selection and physical PAT
revocation, which require their own lower-layer and assembled witnesses.

## Decision

Five defaults and creation refusal cases extend the shared strict Bot HTTP
fixture. The production mux, request logging, PAT and Session cookie
authentication, Origin validation, parsing and response encoding remain active.
CreateResolved and DefaultsFor verify exact raw arguments, request context and
principal. Invalid JSON, unsupported methods and cookie Origin failures call
neither operation. Bad IDs and whitespace model input reach their production
operation and receive controlled domain refusals. The legacy Defaults operation
fails the test if called. [Bot definition HTTP decision](2026-11-18-bot-definition-http-test-owners.md)

Independent results preserve the empty Worker array, UTC timestamps, candidate
order and provider data, private response headers, explicit offline selection,
foreign Worker refusal and active Worker overflow. The fixture verifies the
uppercase Worker ID reaching DefaultsFor before service canonicalization.

The service tests pass the DAO's observation time, ordered Worker records
and preferences through the real resolver. They check automatic selection
and a canonical explicit offline selection. Core preserves the observation
time, skips an unsupported online legacy Worker and refuses foreign Workers
or 101 usable candidates. The PostgreSQL tests verify candidate bounds and
the default reader's owner scope, heartbeat age and stored provider data.

The three full-application creation tests retain physical creation, readback,
reconciliation after response loss, replay with an offline Worker and conflict
handling. The name-only creation test ends by deleting its actual PAT row and
checking that authenticated defaults and create routes refuse the old bearer.
The controlled preview case also checks that a revoked bearer reaches neither
Bot operation.

## Alternatives

**Keep the database and gateway setup in every HTTP case.** This repeats the
full application and synthetic Worker setup for wire and middleware outcomes.
The existing integration and lower-layer tests can expose regressions in the
business and physical mechanisms with fewer schema preparations.

**Retain only a supplied revoked credential result.** It would exercise the
Bot route's middleware ordering but would leave the exact assembled Bot route
after a real credential deletion uncovered. Reusing the name-only creation
schema retains that sequence.

## Consequences

The five HTTP runner selections execute with the database and gateway fixture
variables unset. The retained successful creation and physical revocation
scenarios still require their real application environment. Each controlled
request declares its own result, keeping preview projection independent from
captured inputs.
