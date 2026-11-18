# Agent Note: Device Form Fixtures

Status: implemented

## Problem

The device form and browser-Origin test created a real login and device
authorization before verifying HTTP parameter handling. The database work
supplied fixed credentials and codes for the adapter cases.

## Decision

Controlled identity operations provide an admitted browser principal,
a device-start result and delegated invalid results. The actual HTTP route
validates methods, Origin, body bounds, form syntax and JSON fields. Inputs
rejected by the adapter never reach identity operations.

Real PostgreSQL and gateway tests retain device approval, account switch,
redeeming, expiry and rate limits. Core still validates the delegated request
arguments.

## Alternatives

**Create a real device grant for form tests.** This repeats persistence to
obtain a code, while the lifecycle tests already prove how the code is
issued and used.

**Replace the browser and device handlers.** This would skip the form,
Origin and method enforcement the cases verify.

## Consequences

The form matrix can run without a database or auth gateway. The physical
device lifecycle still uses its existing isolated fixtures.
