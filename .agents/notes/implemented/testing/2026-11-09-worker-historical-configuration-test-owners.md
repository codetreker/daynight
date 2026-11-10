# Agent Note: Worker Historical Configuration Test Owners

Status: implemented

## Problem

Historical Worker configuration repair tests combined input admission, retained
Project policy, no-op decisions, authorization SQL and JSONB readback in service
fixtures. Fixed rule observations therefore required identity, Project and
PostgreSQL preparation, while replacing the complete fixture would lose actual
stored-value and permission observations.

## Decision

Core tests execute `PutConfiguration` over independently supplied current data,
setter results and complete expected resources. They retain repair of stored 65
to candidate 64, unchanged revoked Project overrides, reauthorization of changed
args, Project removal, repair to 2 and a timestamp-preserving no-op. Unconfigured
DAO calls fail; mock writes do not become later read facts. Core expected JSON
uses independently constructed canonical override bytes.

Service tests execute the real input parser and normalization, reject a new 65
candidate before storage or lower operations, and separately transmit an explicit
repaired read result. These controlled results do not establish persistence.

The PostgreSQL Worker contract suite retains actual grant insertion and removal,
permission queries, the raw JSONB update to 65, committed writes and fresh full
configuration reads. Permission denial is observed through a fresh Worker write
DAO independently from the supplied repair write; Store does not decide whether
unchanged Projects may remain. Raw args retain PostgreSQL's canonical spelling
and their original semantic values. Expected resources are independently built,
with returned timestamps used only for cross-read consistency.

The [test-writing rules](../../../../docs/writing_tests.md) own layer boundaries.
The [configuration service decision](2026-11-09-worker-configuration-test-boundary.md)
retains the actual input mechanisms and direct-operation seam. Other bootstrap,
CAS and report-budget proofs keep their existing owners.

## Alternatives

**Keep historical rules in service database fixtures.** This repeats unrelated
identity and Project setup and keeps Core policy inside the service proof.

**Replace the complete fixture with mocks.** Supplied results cannot prove the
SQL grant transition, JSONB preservation or committed configuration readback.

## Consequences

Historical policy and candidate admission execute without database fixtures;
physical data and permissions remain tested against isolated PostgreSQL.
Receiving suites retain their cost, and source-bound measurements distinguish
case costs, package duration and command wall time without inferring CI savings.
