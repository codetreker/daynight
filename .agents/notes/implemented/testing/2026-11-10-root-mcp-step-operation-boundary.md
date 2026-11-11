# Agent Note: Root MCP Step Operation Boundary

Status: implemented

## Problem

The Root MCP Step lifecycle test used controlled DAOs but executed Identity and
Step business operations to obtain fixed protocol facts. Its observations mixed
production registration and wire adaptation with lower admission, transaction
coordination and capture. Removing those lower observations without receiving
proofs would weaken the existing failure detection.

## Decision

The original lifecycle test constructed the real application and replaced its
exported Identity and TaskSteps outputs before constructing the Server. Strict
direct operations supplied independent facts and checked each request's principal,
context, arguments, order and calls. Real authentication adaptation, tool
registration, schemas, SDK, HTTP and response encoding remained in the test.
The Application assembly tests separately verified default constructor bindings.
The later [component ownership decision](2026-11-11-go-component-test-ownership.md)
moves the lifecycle matrix to a focused MCP Entry host while retaining those
operation and wire observations; Root retains application assembly proofs.

Step read, content and order Service tests retain their coordination proofs;
Core owns admission and encoding, and the Webhook Capturer owns event freezing.
Store tests retain SQL, transaction and persisted-state proofs. The
[Root DAO decision](2026-11-09-root-http-test-dao-ownership.md) records the
earlier fixture boundary, which this decision changes for this Step matrix.
The [Step limits decision](2026-11-10-step-limits-test-ownership.md) records
the distinct Core capacity and text receivers.

## Alternatives

**Keep the DAO-only fixture.** It preserves the protocol path but continues to
execute lower business decisions to construct results at the Root boundary.

**Replace production application construction.** A synthetic application could
hide a registration or assembly defect; the real constructor and exported slots
retain the intended wiring observation.

**Model state in the operation mocks.** Deriving subsequent reads from proposed
writes would couple the oracle to a simulated persistence implementation and
could conceal incorrect wire arguments.

## Consequences

The operation test isolates protocol and registration failures without claiming
that controlled completion proves persistence. Receiver tests remain necessary
and contribute to validation cost; package timing alone does not establish a
hosted CI improvement. Other Root MCP and Identity matrices retain their own
existing boundaries.
