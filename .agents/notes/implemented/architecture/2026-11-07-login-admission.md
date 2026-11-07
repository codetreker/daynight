# Agent Note: Login Transaction Admission

Status: implemented

## Problem

Pending login transactions consume persistent capacity, and per-state browser
bindings cannot count outstanding logins across a browser context. Concurrent
replicas must enforce both browser and service limits without invalidating
existing transactions or changing one-time callback consumption.

## Decision

A separate first-party random scope cookie identifies a logical browser context;
the database stores only its hash. A bootstrap redirect establishes it before a
pending transaction is created. Admission serializes on a database transaction
lock, counts unexpired entries using fresh database time, and performs cleanup
and insertion only after both limits pass. The separate per-state binding still
protects callback consumption. The [authentication design](../../../../docs/design/daynight-auth.md#登录和凭据)
owns the mechanism and migration conditions.

## Alternatives

**Count binding cookies.** Each binding has a different name and clients can omit
cookies, so the count would not represent the server's pending transactions.

**Assign scopes to old transactions.** Existing rows contain no trustworthy scope;
synthetic assignments would misrepresent their origin. Migration waits for their
consumption or expiration instead.

## Consequences

The global lock makes admission atomic across replicas at the cost of serializing
short login transactions. The cookie represents a logical context, not a physical
browser: clearing it or concurrent initial requests can establish new scopes.
The global limit remains the shared capacity boundary.
