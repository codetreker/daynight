# Agent Note: Attachment Service Test Ownership

Status: implemented

## Problem

Attachment service tests opened PostgreSQL and initialized identities, Teams,
Projects and Tasks to obtain facts for admission, orchestration and error
assertions. Repeating that preparation coupled service feedback to unrelated
schema and fixture work. The same suite also checked actual SQL, row locks,
transaction readback and filesystem behavior, so replacing its database
connection without allocating those proofs would lose meaningful detection.
A strict DAO fixture alone also executes Project-read and Attachment metadata
business operations inside service tests, coupling orchestration assertions to
lower decisions and error translation.

## Decision

The complete `internal/service/attachment` suite constructs synthetic principals,
Project and Task data and controls directly invoked Project-read, path-conflict
and metadata read/write/delete operations through private instance-owned function
dependencies. The production constructor binds the real Core functions. Snapshot,
attachment mutation and directly used DAO interfaces remain controlled separately.
Strict call plans check the exact callback capability, context, arguments and
order, rejecting extra, unconfigured or unconsumed calls. Lower business DAO
calls fail explicitly, so a service fixture cannot silently resume real Core
operations. Expected operation and query results are explicit facts; recorded
writes do not determine later reads or emulate persistence.

Transaction callbacks, proposed metadata writes and completion results are
separate. Service tests supply `committed`, `not_committed` and `unknown`
outcomes, preserve the original error chains and verify whether file effects
remain possible. An unknown result cannot produce a success receipt or justify
compensating an external file change. The test binary clears database and
UniAuth fixture variables, including when complete module validation supplies
those resources to other packages.

Service assertions retain canonical Project/Task/shard addresses, authorization
and presence order, admission, file/metadata order, context cancellation, exact
content propagation, lease identity and capacity, retained permits, staging,
publication and reader cleanup. File objects and permits stay real where their
use and lifetime are the mechanism being tested. The actual content reader
still consumes the existing 5 MiB and excess input. Production capacities and
timing defaults are unchanged.

Physical observations follow the implementation responsible for them:

| Owner | Retained proof |
|---|---|
| [Core Attachment](../../../../packages/daynight-server/internal/core/attachment/attachment_test.go) | Exact conflict-query Project/Task/context delegation and ancestor/descendant query; metadata write/delete input, canceled-context identity, one-call forwarding and error chains |
| [Core Project read delegation](../../../../packages/daynight-server/internal/core/project/read_access_delegation_test.go) | The original Attachment principal, Project ID and context reach the read DAO unchanged; the complete inherited access result is preserved |
| [Attachment DAO](../../../../packages/daynight-server/internal/core/store/postgres/attachment/dao_integration_test.go) and [metadata regressions](../../../../packages/daynight-server/internal/core/store/postgres/attachment/metadata_regressions_test.go) | SQL mapping, upsert identity and timestamps, Unicode/case pagination, literal `%` and `_` prefix behavior, persisted legacy paths and content types, affected-row refusals and unchanged Task rows |
| [PostgreSQL lifecycle witnesses](../../../../packages/daynight-server/internal/core/store/postgres/attachment_lifecycle_witnesses_test.go) | Actual Task/Project deletion barriers in both orderings, independent resources, admitted grant removal, transaction completion and persisted readback after file publication, cancellation or backend loss |
| [Local storage](../../../../packages/daynight-server/internal/core/filestorage/local/) | Native case behavior, target gates across instances/processes, old readers, staged publication and exact physical bytes |
| [Namespace tests](../../../../packages/daynight-server/internal/core/filestorage/local/namespace_test.go) | Same-name files under the original four task/shard/project prefixes, overwrite isolation, sibling survival, empty-directory pruning, bucket survival and legacy long Unicode paths |
| [Fresh-process persistence](../../../../packages/daynight-server/cmd/daynight-server/persistence_process_test.go) | Metadata and exact bytes survive a real Server restart |

Store witnesses execute direct DAOs and scope callbacks rather than replaying
complete service rule matrices. Existing equivalent local and core proofs remain
with their owners. Core input tests own exact path, MIME and content boundaries, while Core metadata
tests retain query construction, not-found translation and precise write fields.
Service tests retain real pure input, cursor and encoding helpers and verify how
those inputs reach the orchestrated operation. Normal
assembled attachment create/read/replace/list/delete remains in the existing
API integration flow. Boundary, fault, race and recovery matrices keep their
module or mechanism owner.

The [test-writing rules](../../../../docs/writing_tests.md) own layer isolation.
The [server guide](../../../../packages/daynight-server/README.md#attachment-service-and-store-tests)
owns executable commands. The earlier
[Attachment HTTP ownership decision](2026-11-08-attachment-http-test-ownership.md)
retains its protocol and stalled-TCP rationale; its physical witnesses use the
same Store and local-resource owners.

## Alternatives

**Retain complete PostgreSQL fixtures for every service branch.** These fixtures
supply valid stored data but repeat schema, identity and unrelated service work
for decisions that require only explicit collaborator facts. Physical mechanisms
still need their isolated database fixtures at the Store layer.

**Keep DAO mocks beneath real Core operations.** Database isolation removes
infrastructure setup but still couples service cases to Project authorization
and Attachment metadata decisions. Direct operation dependencies allow independent
results and refusals while preserving real service callbacks and file mechanisms.

**Replace native mechanisms with fixed mock results.** Mocked gates, readers or
completion values cannot establish real file exclusion, SQL blocking, rollback
or persisted readback. Controlled dependencies isolate service decisions, while
mechanism tests retain the resources required by their actual assertions.

## Consequences

Service feedback executes without PostgreSQL, authentication-service setup or
lower Core business operations. The private dependency fields add no public
constructor or global hook. Existing scenarios preserve their orchestration,
error, capacity and resource lifetime assertions. The physical witnesses retain their original meaningful
inputs and readback under their own implementation owners.

A supplied mock completion is not proof of persistence, and successful Store
readback does not establish service admission or cleanup. Both layers contribute
to the original combined signal. Measurements include the receiving Store and
local packages with matching source, toolchain, cache, instrumentation and
resource limits. Source-bound validation owns sample counts, observed timings,
fault controls and hosted results; a service-package speedup alone does not
establish a lower complete-command or CI job cost.
