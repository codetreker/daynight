# Agent Note: Root HTTP Test DAO Ownership

Status: implemented

## Problem

Root HTTP tests prepare database schemas, complete authentication flows and
Project, Task and Worker resources to obtain inputs for protocol and lifecycle
assertions. This repeats persistence work outside its owner. Some of the same
tests also observe actual SQL locks, committed rows, file content or process
shutdown, so replacing their fixtures without distinguishing those mechanisms
would weaken the existing evidence.

The earlier [HTTP scenario consolidation](2026-11-06-server-http-proof-owners.md)
removed copies while retaining complete application fixtures. Dependency
ownership is a separate decision: a distinct root composition assertion does
not require a database when its persistence facts can be supplied explicitly.

## Decision

The original root-unit correction replaced database preparation with strict
callbacks on the existing `store.Transactions`, scope and DAO interfaces. That
retained production module assembly and existing lower business decisions while
removing persistence setup and making transaction outcomes and runtime barriers
explicit.

The later [Root operation fixture decision](2026-11-11-root-server-operation-fixtures.md)
supersedes this boundary for ordinary business-result fixtures. They now use
controlled direct operations with the shared production HTTP router; full MCP
and default assembly retain real construction. Runtime mechanism fixtures that
still require the earlier DAO boundary use explicit callbacks to assemble
production modules, routes and authentication. Each test declares query inputs, returned
facts, proposed writes, expected calls and transaction completion. A subsequent response is independently supplied;
capturing a proposed write does not make it persistent. The fixtures contain no
mutable model database or simulated rollback. Unconfigured access fails, and
concurrent work uses operation-specific observations and explicit barriers.

Authentication fixtures provide controlled credential facts to the actual
adapter. Tests of the UniAuth SDK and browser/result binding retain their real
local gateway, proxy and socket-loss mechanism. Native resources remain real
when they are the subject: HTTP/TCP, MCP SDK exchanges, WebSockets, Session
Engine state, local file publication and runtime shutdown all execute their
production paths. Dedicated runtime composition cases keep HTTP control and WebSocket traffic
on one actual application and Engine; ordinary fixed-result protocol fixtures
follow the replacement direct-operation boundary. Large native content and exact supported capacity
boundaries remain unchanged.

PostgreSQL tests own SQL, lock waits, database-clock expiry, transaction outcomes
and fresh committed readback. Existing owners retain the original independent
row and cross-operation observations, including credential rechecks after
unchanged locks, startup fences, property projections, immutable transfer data
and Session disconnection. Process tests retain complete entry-point assembly,
drain and restart persistence. Upper-layer rejection with a strict zero-call
mutation oracle does not need a duplicate business matrix in the Store.

Runtime unit tests observe actual request and operation admission, context
cancellation, transport drain, relay ordering, dependency retention and retry.
Configured DAO work supplies barriers without pretending to be a SQL query.
The Store cancellation witness independently observes the original query in
`pg_stat_activity`, cancels it, joins closure and checks that it is no longer
active. The process drain witness checks complete persisted Tasks across restart.

Webhook composition verifies real worker lifecycle over explicit delivery
callbacks. Disabled maintenance is observed through completed maintenance
passes while claim and outbound access remain forbidden. PostgreSQL recovery
checks the actual leased-row update and immutable data; process restart checks
the original destination and signing secret.

The [test-writing rules](../../../../docs/writing_tests.md) own dependency and
integration restrictions. The
[Root MCP Step decision](2026-11-10-root-mcp-step-operation-boundary.md)
assigns that lifecycle matrix to direct Identity and Step operations after its
lower receivers exist. The
[Worker Report capacity decision](2026-11-09-worker-report-capacity-test-owners.md)
partially supersedes the DAO mock boundary for that HTTP matrix, preserving its
lower validation and projection proofs with Core. The
[Configuration capacity decision](2026-11-09-worker-configuration-capacity-test-owners.md)
assigns its eight HTTP cases and receiving Core input/business proofs to the
same direct operation boundary. The
[assistant-host HTTP decision](2026-11-09-worker-assistant-host-http-test-owners.md)
assigns the first reporting/detail/list case to controlled operations and retains
its validation, complete snapshot and service-stage observations separately.
The [configuration compatibility HTTP decision](2026-11-09-worker-assistant-host-configuration-http-test-owners.md)
assigns the second assistant-host case to controlled operations after its lower
receivers exist, removing its unconsumed shared DAO/application fixture. Existing
scenarios are corrected in place or consolidated with an existing mechanism owner; protocol
matrices are not added to normal API integration or product E2E.

The [Bot expiry HTTP decision](2026-11-10-bot-expiry-http-test-owners.md)
assigns its Runtime and deletion request matrices to direct operations after
preserving their registration and constructor observations at their owners.

## Alternatives

**Reuse complete application/database fixtures.** This can reduce repeated
startup but leaves protocol and rule tests dependent on persistence and shared
mutable resources. The existing interfaces already support direct inputs.

**Replace every real resource with a returned result.** A mock cannot establish
socket deadline behavior, actual relay traffic, file publication, SQL rollback
or process persistence. Only dependencies outside the mechanism being observed
are controlled.

**Move complete HTTP scenarios into Store tests.** This retains their expense
and duplicates business and protocol rules at the wrong layer. Store cases
retain only the independent SQL, locking and persistence observations.

**Simulate a Store in memory.** Evolving records from writes or reconstructing
rollback reproduces database policy and can make producer and oracle share the
same error. Explicit response phases and separate completion facts expose the
upper-layer decisions without that second implementation.

## Consequences

The original DAO correction removed PostgreSQL preparation from root feedback.
Ordinary business-result fixtures subsequently move to direct operations under
the replacement decision; remaining DAO callbacks serve their actual assembly
or resource mechanisms. Physical proofs remain in tests that exercise the responsible
database, filesystem or process mechanism. Controlled authentication removes unrelated login setup
without removing the SDK boundary from tests that actually observe it.

The receiving owners still incur real persistence cost. Source-bound evidence
therefore compares the root package, the receiving-package command and the
complete module gate separately, with matched instrumentation, cache and
resource budgets. Local package timing does not establish hosted job savings.
Matched fault controls check detection across the old and corrected owners;
test counts and coverage totals alone do not establish equivalent evidence.
