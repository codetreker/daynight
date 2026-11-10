# Agent Note: Worker Assistant-Host Configuration HTTP Test Owners

Status: implemented

## Problem

The assistant-host configuration compatibility test obtained bootstrap receipts,
configuration refusals and legacy heartbeat responses by assembling the complete
application and running real Worker service and Core operations through DAO
mocks. Its nine requests observed both wire adaptation and lower decisions, so
removing the DAO fixture without receiving those decisions would lose evidence.
The earlier root correction had already removed real database preparation; it
still repeated unrelated route and MCP assembly to obtain fixed protocol facts.

This decision partially supersedes the [root HTTP DAO boundary](2026-11-09-root-http-test-dao-ownership.md)
and completes the HTTP separation established by the [assistant-host proof owners](2026-11-09-worker-assistant-host-http-test-owners.md).
The receiving Core, Service and Store proofs exist independently of the HTTP
fixture, including exact bootstrap values and fresh persisted observations.

## Decision

The compatibility test uses the shared strict Worker operation fixture with
actual Worker routes, request authentication, logging, parsing and encoding.
Configuration joins Report, Get, List and PutConfiguration as an explicitly
configured operation. Each request verifies its post-logging context, complete
principal, canonical Worker ID and exact call count, then clears its callback.
Unconfigured operations fail independently.

The original nine requests call Report, Get and Configuration three times each.
Bootstrap retains the complete 3/60000/0 configuration, nullable native model and
non-null empty Args and Projects, full ordered host providers and a nil inventory.
The version-one receipt retains desired revision one, the fixed timestamp,
observation revision zero and false acceptance. The future observation reaches
Report with its complete base-zero/desired-two input and receives a supplied
invalid-input refusal. Subsequent reads supply fresh independent original facts.
The legacy report has no host, configuration or inventory; its raw response has
exactly the two timestamps and no configuration negotiation header.

Report expectations are decoded independently from raw JSON primitives before
dispatch. Fresh factories supply configuration resources, receipts and their
expected values. Get results derive from independent raw input snapshots, never
from captured writes. These facts verify HTTP transmission without simulating
persistence or rollback. The first reporting test, capacity matrices and their
strict callbacks remain intact.

Core retains real bootstrap and future-observation decisions. Service retains
controlled-operation sequencing for bootstrap, refusal and legacy paths, complete
parameters, refusal chains and independently supplied transaction completion.
Store retains actual SQL, committed telemetry replacement, unchanged configuration
and fresh Worker/configuration snapshots. The fresh Worker observation strengthens
the Store proof; former HTTP DAO mocks did not execute SQL.

The old capacity DAO, scope, call-plan and complete-application fixture have no
remaining consumers and are removed. Their file retains only the shared timestamp
and pure JSON/snapshot expectation helpers used by the direct HTTP selections.

## Alternatives

**Keep the combined DAO/application fixture.** This preserves the lower witnesses
but repeats business execution and unrelated registration for wire assertions.
Separate receiving owners already retain those decisions and physical mechanisms.

**Replace the HTTP fixture before receiving its lower observations.** Supplied
receipts and refusals cannot prove bootstrap revision/value, future-observation
rules, extra configuration reads or legacy exchange suppression. Those Core and
Service cases remain required alongside the corrected HTTP test.

**Populate reads from captured Reports.** That creates a mutable storage
substitute and can make producer and oracle share an error. Independent supplied
read facts preserve the original response observations without that second model.

## Consequences

Both assistant-host HTTP selections and their Core/Service receivers execute
without database or UniAuth fixtures. Native HTTP parsing, headers, omission and
encoding remain real. Physical commit, rollback and fresh reads remain with Store.

Source-bound comparisons include the unchanged receiving Core, Service and Store
costs as well as the HTTP case and root package. Faster case feedback does not
establish hosted CI savings. Matched faults distinguish preserved full input and
legacy wire detection from the separately owned business and SQL proofs.
