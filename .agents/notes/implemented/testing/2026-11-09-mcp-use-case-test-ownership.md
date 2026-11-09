# Agent Note: MCP Use-Case Test Ownership

Status: implemented

## Problem

MCP protocol tests prepared complete PostgreSQL schemas, identities and business
services to obtain fixed Task and attachment results. Team tests used DAO fakes
but still executed service and core decisions. Their failures mixed protocol
adaptation with business admission, transaction completion and persisted state.
The same fixtures also repeated schema initialization and tool registration.

Some protocol scenarios were the only callers of lower admission and cleanup
branches. Replacing their fixtures without identifying those observations would
lose defect detection even if package coverage remained high. The common
[dependency decision](2026-11-08-go-test-dependency-boundaries.md) establishes the
required collaborator boundary.

## Decision

MCP tests execute the actual authenticated Entry, HTTP parser, SDK, tool schemas,
response envelopes and resource budgets. Consumer-owned operation contracts
accept the existing production services directly. Tests configure operation
results, errors and completion facts and verify principals, authority, context,
addresses, inputs and call counts. They do not model Task persistence or execute
lower business rules to manufacture HTTP responses.

Task response admission remains in the Task service. Its typed response context
exposes request ID, RPC ID, protocol, batch and projection facts to both the
adapter and the admission consumer. Protocol tests observe those exact facts;
service tests exercise the actual admission encoder, including exact and excess
byte boundaries. Store tests retain physical rollback and committed readback.
An operation mock's response is never treated as evidence of persistence.

Team protocol tests execute the envelope-size callback supplied to the service.
The service owns candidate-prefix selection, continuation and oversized-first
item refusal, with explicit lower query results. Upload and download protocol
tests retain action mapping, credential authority, admission, cancellation and
request drain; the respective services own transfer receipts, retry/status
observations and deleted-project operation refusal. Store retains the actual
project lifecycle and credential reads. Attachment file-effect errors expose
their cause while retaining the original error chain, allowing the adapter to
interpret completion facts independently of file execution.

The MCP test binary clears database and UniAuth fixture variables before test
execution. Full module validation can provide infrastructure to its physical
owners without lending it to these protocol units. Native body-timeout tests
assert the 15-second production default and use a 200-millisecond instance value
through the same logical body deadline and actual socket deadline. The timeout
response, connection close and input-slot release remain observable.

## Alternatives

**Keep complete business fixtures for protocol boundaries.** Database setup and
business decisions remain on every protocol feedback path. Their result does
not isolate whether argument adaptation or the lower rule failed.

**Mock only DAO calls.** This avoids PostgreSQL but still repeats service and
core rules in the server suite and permits fixtures to become storage simulators.

**Replace mixed tests with fixed successful responses only.** This loses the
original lower admission, cleanup and refusal observations. Each unique proof
must execute in its actual owner before its protocol copy is removed.

**Cache definitions globally or parallelize the whole package.** Registration
failure tests replace embedded definition bytes. A process-wide cache could hide
those failures, and shared mutable definitions prevent unrestricted parallelism.
These mechanisms remain independently testable and sequential.

**Intercept only the socket timeout.** The HTTP server can cancel the request
before the logical body deadline, changing the expected timeout classification.
An instance duration must reach the complete existing deadline-body path.

## Consequences

Protocol tests execute without database or authentication-service preparation.
Their collaborators are explicit, while actual framing, escaping, exact byte
limits, SDK compatibility, cancellation, shutdown and admission stay in the
protocol suite. Lower rule, transaction and persistence observations retain
separate owners and failure causes.

Receiver tests are part of validation cost. Constrained-container measurements
compare matching source, toolchain, instrumentation, caches and resource budgets;
source-bound task artifacts retain samples, fault detection and hosted results.
A package speedup alone does not establish an equal whole-job improvement. The
[server guide](../../../../packages/daynight-server/README.md#mcp-protocol-tests)
owns commands and the current test boundary.
