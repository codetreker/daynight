# Agent Note: MCP Download Source Operation Tests

Status: implemented

## Problem

Inspect and inline tests prepared PostgreSQL, Task and Attachment state to obtain
fixed source bytes. Their service coordination and encoding assertions depended on
lower business operations, obscuring failures and repeating setup unrelated to
the mechanisms being checked.

## Decision

Download Service binds its private authorization operation to the actual
Lifecycle method in `New`, passing the current Lifecycle receiver explicitly.
The selected inspect and inline tests control the Opener and authorization
results independently and verify arguments, order and calls. They retain actual
local files, body reads and closes, size checks and UTF-8/base64 encoding. Source
metadata is a supplied fact rather than a simulated database state.

The existing [MCP transfer ownership decision](2026-11-09-mcptransfer-test-ownership.md)
retains the lower authorization and physical resource proofs. Other Download
operations and database-backed cases remain outside this isolation, including
revocation while waiting, gates, private snapshots, renewal and cleanup.

## Alternatives

**Keep complete database and attachment preparation.** It supplies real domain
state but repeats lower business work for fixed source and encoding facts; real
credential and persistence proofs remain with their existing owners.

**Replace the file body with supplied encoded outcomes.** This would lose the
actual read, close, size and encoding mechanisms that these cases need to prove.

## Consequences

The selected cases can execute without database or authentication fixtures while
still exercising file I/O and Service coordination. Controlled authorization is
not evidence of credential validity or persistence, and the rest of the Download
package still uses database fixtures and other direct Lifecycle operations. The
constructor retains its public signature and renewal interval.
