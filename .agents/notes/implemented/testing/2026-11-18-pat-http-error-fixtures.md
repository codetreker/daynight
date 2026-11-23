# Agent Note: PAT HTTP Error Fixtures

Status: implemented

## Problem

The Auth HTTP input and expiry response tests started UniAuth and PostgreSQL to
obtain fixed credentials, timestamps and errors. The test claims concern the
adapter's parameter handling, delegated requests and response mapping.

## Decision

Controlled identity operations supply exact request and result facts to the
real HTTP authentication and PAT routes. Adapter refusals cannot reach the
identity operation. Delegated validation receives the original input and
actor through the actual handler. Successful responses check the exact field
set and UTC timestamps, including the last usage time.

Real credential and Store suites retain expiry, revocation, token hashes,
updates and persisted readback. The physical Store tests also supply the
database failure proofs behind the HTTP mapping.

## Alternatives

**Keep the database for every PAT response check.** It would repeat credential
issuance and fixture mutation for request shapes and output mapping.

**Stub the PAT route.** This would skip the authenticated actor and input
transformation which the HTTP test verifies.

## Consequences

The selected HTTP cases can run with no database or auth gateway. The
existing real credential tests retain persistence and lifecycle coverage.
