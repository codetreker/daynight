# Agent Note: Worker Report Capacity Test Owners

Status: implemented

## Problem

The Worker Report HTTP capacity matrix executes real service and Core rules
through a complete application with DAO mocks. It registers unrelated routes
and MCP schemas for thirteen pairs of input checks. HTTP argument propagation
and error mapping therefore depend on lower business decisions.

The [root HTTP DAO decision](2026-11-09-root-http-test-dao-ownership.md)
removed real database preparation while retaining production assembly, existing
business paths and explicit storage outcomes. That correction isolated
persistence cost, but its DAO boundary still leaves business rules inside this
protocol matrix.

## Decision

This decision partially supersedes the root HTTP DAO boundary for the Worker
Report capacity matrix. The fixture registers only production Worker routes,
request logging and real credential middleware. The existing Worker service
interface accepts strict direct-operation callbacks. Unconfigured calls fail
independently of HTTP error handling. Each request checks context, principal,
canonical Worker ID, complete Report arguments and exact call counts.

Eleven byte-field boundary and overflow inputs each reach Report exactly once;
supplied success or `invalid_input` results isolate argument propagation and
error mapping. The actual HTTP parser rejects 257 claims and 129 runtime
projects before Report, while the 256-claim and 128-project inputs arrive in
full. Expected Reports are decoded from original wire maps before dispatch
through independent model decoding, with telemetry and inventory assembled
explicitly. Real response encoding retains supplied timestamps and private
identity/cache headers.

Core validation retains all original thirteen boundaries, UTF-8 byte values and
overflow refusals. Each valid boundary runs actual validation, matching over
empty sources and snapshot projection. Separate fresh typed inputs and expected
values preserve complete telemetry, ownership, server and inventory timestamps,
and explicit empty task observations without shared mutable pointers or slices.
The [Worker admission decision](2026-11-09-worker-admission-test-owners.md)
records service operation binding and rejection before subsequent storage work.

## Alternatives

**Keep the capacity matrix behind DAO mocks.** This retains real lower business
decisions and unrelated application construction for HTTP argument checks. A
service refusal also cannot prove that the HTTP adapter refused to call Report.

**Replace lower assertions with supplied operation results alone.** A mock result
cannot prove actual byte/count admission or full snapshot projection. Those
observations remain in Core with independently constructed expectations.

## Consequences

The Report HTTP capacity subset executes with database and UniAuth fixture
variables unset. Protocol and call-count proofs stay separate from actual Core
validation and projection. Configuration and assistant-host capacity cases retain
their existing fixtures and separately owned guarantees; complete root suites
retain their own environment requirements.

Matching performance comparisons include the receiving Core package and full
validation. Package elapsed times and a faster subset do not establish hosted
job savings. Source-bound fault checks must verify preserved detection across
the former combined test and the corresponding HTTP, service and Core owners.
