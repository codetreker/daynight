# Agent Note: Business Application Assembly Tests

Status: implemented

## Problem

The business Application test opened PostgreSQL and ran Project, Task and
Attachment workflows to observe shared dependencies. That mixed module assembly
with lower business rules and storage. Removing the workflow would also remove
its implicit wiring proof, while replacing Application in the fixture could
hide defects in the production construction body.

The existing Session/Engine assertions prove actual shared resource lifetime:
Session operations hold the application Engine open, and Engine stop prevents
new Session work. Static identities or mocked stop results cannot replace that
mechanism.

## Decision

The public Application constructor and its unit test share one production
assembly body. Private construction bindings cover the three collaborators in
the original shared dependency proof: Projects, Tasks and Attachments. Default
bindings invoke their production constructors; small closures adapt private or
variadic constructor parameters to the borrowed capabilities at this boundary.
Identity also has a private constructor binding with the exact production signature,
directly bound to `identity.New`. Task Observations likewise uses the exact
`task.NewObservations` binding; other pure constructors remain real.

Recording construction wrappers observe the supplied store, files, Engine and
Capturer and return the real objects built by the child constructors. Tests
verify argument identity, call counts and returned module identity without
invoking lower business operations. The public constructor still has actual
Session/Engine identity, origin propagation and operation/stop/close assertions.
The Identity constructor receives the same writer, client and callback and its
concrete result occupies the exported `IdentityOperations` output. This 18-method
output satisfies the [Authentication consumer](2026-11-10-auth-identity-consumer.md)
and the [MCP Personal Team resolver](2026-11-09-mcp-use-case-test-ownership.md)
structurally, allowing controlled output after real assembly. The production test
checks the concrete Identity and callback; it does not prove Identity business
behavior. Store and files remain borrowed from their external owners.
The five-method `TaskObservationOperations` output satisfies the HTTP and MCP
observation consumers, allowing controlled operations after real assembly.
The constructor test checks the original snapshot reader, the shared Engine as
Session observer, one call and the exact returned object. Production construction
retains a non-nil concrete Observations instance. Observations borrows the reader
and observer, and neither starts nor owns their lifetime; its business rules
remain with their Service, Core and Store owners.

The existing normal API attachment flow retains Project and Task creation,
complete attachment-byte readback and the final same-Project identity read.
That flow exercises the production Server, authentication, database and default
construction. Module and Store owners retain their rule and persistence proofs;
assembly units do not manufacture business state or simulate a database.

The [Go dependency decision](2026-11-08-go-test-dependency-boundaries.md)
owns the direct-operation policy. The
[outer service assembly decision](2026-11-09-root-service-test-ownership.md)
owns opening and closing external resources; these inner construction bindings
do not replace or expose its resource openers.

## Alternatives

**Retain lower workflows behind DAO mocks.** This removes PostgreSQL but still
executes Project, Task and Attachment rules inside an assembly test. It does not
isolate the construction responsibility.

**Inspect private child fields through reflection.** This would couple the
Application test to representation owned by other services. Constructor argument
observation uses the dependency capabilities that assembly actually supplies.

**Add a factory registry for every Application field.** The original dependency
proof concerned three constructors. Identity and Task Observations now have
specific output and construction proofs as well; extending every future module
through a registry would introduce maintenance unrelated to those proofs. Pure
construction needs no substitute when it does not run business operations.

**Remove the normal chain without preserving wiring.** A remaining Engine test
would say nothing about the supplied Project/Task/Attachment dependencies.
Explicit construction assertions retain that responsibility, with normal API
connectivity still observed separately.

## Consequences

The Application unit executes production assembly and shared Engine lifetime
without database or authentication preparation. Construction bindings add a
narrow internal dependency seam; production default construction is still
verified through public entry and normal API consumers.

Exact store/files object identity is a more precise assembly oracle than the
old normal chain. Different connections to the same database or an internally
consistent wrong file object could pass that chain. Shared Engine faults can be
compared against both versions; new identity precision is reported separately
without claiming an original oracle that did not exist.

Source-bound task evidence owns measurements and fault results. Lower normal
work moved to an existing API flow remains validation work, so package feedback
improvement does not by itself establish whole-command or hosted CI savings.
