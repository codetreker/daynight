# Agent Note: Go Test Dependency Boundaries

Status: implemented

## Problem

The common Go test policy grouped every non-store unit test under DAO mocks.
That wording allowed an HTTP test to run real service and core decisions as long
as its database was mocked. Existing Task HTTP matrices mixed protocol
assertions, business transitions and persisted readback. Full application,
database and authentication preparation obscured the owner of a failure and
made normal API flows difficult to separate from rule and storage proofs.

The earlier [Task request and candidate isolation decision](2026-11-06-task-request-candidate-isolation.md)
separated preflight and candidate rules from storage fixtures. The
[HTTP scenario ownership decision](2026-11-06-server-http-proof-owners.md)
consolidated duplicate full-application scenarios. Those historical arrangements
explain why real fixtures were retained; they do not establish the HTTP unit
collaborator boundary.

## Decision

The [test-writing policy](../../../../docs/writing_tests.md) assigns mocks at the
directly invoked lower operation. Server units execute HTTP adaptation with
service or core use case mocks. Service units execute their own dependency
assembly, orchestration, transaction coordination and shared-resource lifetime
with mocks of directly invoked core and other lower business operations. DAO
mocks beneath real lower business decisions do not establish either boundary.

The regular `internal/server/task` suite uses
consumer-owned `TaskService`, `StepService` and `ThreadService` contracts plus
`SearchOperation` and `SyncOperation` functions. Existing production services
satisfy the contracts directly; the composition point binds the existing Search
use case and Sync operation. No forwarding-only service or whole-application
interface is introduced.

The fixture executes production Task routing, credential middleware, parsing,
DTO conversion, error mapping and server-owned encoding or response writing.
It constructs domain facts and principals directly. Configured callback calls
are required, and unconfigured or extra calls fail independently of HTTP error
handling. Context, identity, canonical IDs, inputs and call counts stay observable
without a database or business state simulator. The package's `!stress` TestMain
clears database and UniAuth fixture variables before `m.Run`, so complete module
validation cannot accidentally lend its infrastructure to these HTTP units.
Stress workloads retain their explicitly tagged fixture and exclude this entry
point.

`RequestAuthentication` owns Bearer and session-cookie parsing, exact Origin
checks, `AuthenticateRequest` and `Require`. It receives the credential
operation. Complete `Authentication` combines that middleware with the concrete
identity service for account, login, PAT and device routes, preserving full
callback/configuration validation. The real middleware can therefore be tested
without constructing unrelated account services or replacing `Require` with a
principal-only wrapper.

Core tests synthesize domain facts and control required DAO results while
executing their business rules. Service tests supply explicit core-operation
results, errors and blocking, checking principal, IDs, inputs, context, bound
capabilities, call counts and required order. They execute their actual scope
callback while configuring lower results, completion and cleanup independently.
This exposes coordination, completion precedence and error propagation without
repeating the lower business-rule matrix.

When production construction or resource lifetime is the subject, assembly
tests control collaborators and external resources while retaining that
construction and wiring. They observe dependency identity, readiness, partial
startup cleanup, background exit, retention and closure after dependency users
stop. Real runtime, transport and resource
mechanisms remain with their owner. Fixed domain data does not require lower
business workflows, and a replacement test application cannot prove production
wiring. Shared models and domain errors remain ordinary values; pure and protocol
mechanisms execute in their owning tests.

Store tests retain real PostgreSQL SQL, locks, snapshots, cancellation, commit
acknowledgement and persistence. Configured committed and unknown results are
inputs to upper-layer tests, not proof that a transaction persisted or rolled
back. HTTP cancellation propagation is distinct from releasing an actual SQL
query and connection.

Step and Thread services supply encoded documents; HTTP tests verify those
bytes, headers, write failures and cancellation. Server-owned envelopes use the
actual encoder, and surviving input/write capacity checks stay with their owner.
Canonical reads do not restore response-byte admission. The
[bounded Raw JSON decision](2026-11-08-bounded-raw-json-batching.md)
owns capped output spans and the shared Writer's byte/error contracts, without
changing each consumer's actual encoded boundary.

The Step handler constructor initializes its body-read duration to the shared
15-second production default. All Step write routes pass that instance duration
through the shared JSON decoder to the actual body reader. The socket regression
checks the constructed default before selecting 200 milliseconds for its own
handler. It retains real TCP timeout delivery, `408 request_timeout`, request ID,
connection closure, handler completion, zero Add calls and the `not_committed`
log outcome. The body reader applies the same duration to its stored deadline
and the socket; changing only the socket deadline can alter cancellation/error
classification. The [Prompt socket decision](2026-11-09-prompt-socket-test-timeout.md)
records the shared decoder's explicit duration entry. Capacity workloads use
their separate `stress` fixture and entry point.

`scripts/integration.sh` builds the production Server and runs explicitly tagged
`cmd/integration_tests` through Go HTTP clients, real authentication and isolated
PostgreSQL. Representative sequential normal flows share one environment and
use distinct resources. Mixed scenarios are assigned to protocol, business,
store or runtime owners; boundary, response-loss, concurrency and stress matrices
are not copied into API integration. Receiver discovery and execution plus
independent proof preservation are required before duplicate normal flows are
removed. The
[independent API integration decision](2026-11-09-independent-go-api-integration.md)
owns its CI scheduling and production build inputs. The runner's Linux process
and cleanup failure tests run as a required step of the independent Linux API
job, keeping those proofs outside the normal API-flow suite and the portable Go
module check.

## Alternatives

**Keep DAO mocks as the uniform non-store boundary.** This still executes lower
business rules in HTTP and service tests, so failures depend on unrelated
service or core decisions. It does not isolate the adapter or orchestration being
verified.

**Share a complete gateway and application fixture.** This retains database,
login and domain preparation for tests whose subject is HTTP adaptation, and it
requires shared mutable-state and cleanup ownership across cases.

**Mock all identity-account methods or replace Require.** An account-wide mock
makes Task tests depend on unrelated identity capabilities; a principal-only
wrapper bypasses Bearer, cookie, Origin and response-identity behavior. A
separate real credential middleware keeps that protocol boundary explicit.

**Move every real-resource test into API integration.** Resource use does not
establish a normal API flow. SQL lock cancellation, lost commit receipts and
runtime recovery need their real mechanisms and failure/concurrency conditions;
a normal-flow suite cannot replace them.

**Keep the production-sized Step timeout in the socket test.** It repeats the
same transport and no-business-call proof with a longer fixed wait. Shortening
only a socket or request-context deadline risks changing error classification;
the instance duration instead reaches the production body reader's logical and
socket deadlines together.

## Consequences

Task HTTP tests obtain controlled feedback without repeating a business or
PostgreSQL implementation. Business rules, exact storage changes and normal
full-application collaboration retain different owners. The [MCP ownership decision](2026-11-09-mcp-use-case-test-ownership.md) applies
the same direct operation boundary to MCP protocol tests and preserves their
lower admission, transfer and physical proofs in their actual owners. Other
domain and process fixtures still carry their own existing scopes; adoption of
the common policy does not claim that every historical suite has been migrated.
Database isolation and direct operation isolation are separate properties.
Changing a mock boundary requires preserving each lower rule and mechanism in
its actual owner before removing the original assertion.

Socket timeout expiration and exact encoded boundaries retain their real
mechanisms. The Step timeout interval is selected per handler, avoiding shared
mutable timing and preserving production defaults without a fixed 15-second
wait in the regression. Performance comparisons must include receiving store/API
suites and complete validation. Source-bound test, profile and CI artifacts own
observed results; package speed alone does not establish faster complete
validation or hosted CI.
