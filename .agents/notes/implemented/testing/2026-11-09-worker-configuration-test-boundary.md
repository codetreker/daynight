# Agent Note: Worker Configuration Service Test Boundary

Status: implemented

## Problem

Worker configuration validation and transaction-failure tests used a real
identity, Project and PostgreSQL fixture for service facts. One mixed case also
proved configuration SQL independence after Task storage was removed. Replacing
that fixture without assigning the physical observation would lose a distinct
persistence guarantee.

## Decision

The Worker service binds its Core configuration write operation per instance.
Production construction selects `core/worker.PutConfiguration`. Configuration
revision parsing and normalization remain real database-independent input
mechanisms. Service tests execute the actual read/write coordination with
controlled snapshots, transaction scopes, DAO identity and Core results.

The existing validation case retains principal and Worker-ID refusals, nil
native arguments and propagation of an already canceled context. Strict
expectations reject Task access and unexpected storage or business calls.
Configuration output, callback errors and transaction completion are independent
facts. The original error-classification cases execute through the actual
configuration write, retaining refusal identity, operational error chains and
suppression of results after unknown or failed completion.

The PostgreSQL Worker contract suite creates the initial Worker/configuration
through direct Store operations, removes Task storage and writes revision 2.
An independent snapshot reads the complete desired value and revision back.
Core configuration rules and other historical bootstrap/CAS cases keep their
existing owners. The [test-writing rules](../../../../docs/writing_tests.md)
define the layer boundaries; the [Worker admission decision](2026-11-09-worker-admission-test-owners.md)
records the independent report/admission partition.

## Alternatives

**Retain the complete database service fixture.** It pays for unrelated identity
and Project preparation while lower operation results and resource failures can
be supplied directly.

**Mock the no-Task write/read observation.** A supplied value cannot establish
that actual Worker SQL remains usable without the Task table.

**Mock every pure input helper.** Revision parsing and normalization have no
hidden database or business workflow. Executing these input mechanisms preserves
the original public refusal observations without adding more operation seams.

## Consequences

The selected service subset executes without database or authentication fixtures.
Physical configuration persistence remains tested with isolated PostgreSQL.
Remaining bootstrap, CAS and capacity suites keep their current fixtures;
source-bound measurements include the receiving Store cost and do not infer CI
completion savings from one subset's elapsed time.
