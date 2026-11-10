# Agent Note: OAuth Service Operation Boundaries

Status: implemented

## Problem

Client registration and authorization service tests built PostgreSQL schemas and
ran complete Core rules to obtain fixed results. This combined service ordering,
HTTP projection, business decisions and persistence in the same assertions, while
transaction callback outcomes and final completion could not be supplied
independently. Removing the database work without restoring its proof owners
would lose actual lock, rollback, cleanup and persisted-readback guarantees.

## Decision

Clients and Authorizations bind private, instance-owned operation collections to
their direct Core and lower business dependencies during construction. The public
constructors retain their signatures. A private Clients constructor accepts the
operation collection so preregistration parsing can be controlled independently
of configuration assembly. Pure value operations, identifier allocation, hashing
and JSON encoding remain real; service control flow and error precedence retain
their existing owners.

Service fixtures execute the actual writer callbacks with narrow scope-bound DAO
capabilities. They independently configure the expected callback error,
transaction completion and final writer error, and check original context,
complete arguments, ordering, call counts and capability lifetime. Supplied
records and completion outcomes do not represent persistence. Supplied mutable
records and raw inputs are copied independently from expected facts, so an
in-place service change cannot also change its own oracle. Approved, expired and
consumed fixtures retain their complete original state and code fields.
Constructor tests check the real function bindings and the actual Admission and Clients instances;
method function addresses alone cannot distinguish bound receivers.

Core tests execute metadata projection, stored-document parsing, redirect
freezing, authorization creation and consumption, decision refusal and code
binding versus expiry. HTTP tests execute the real registration handler with
controlled business results and errors, preserving encoding, status and field
omission. PostgreSQL tests execute direct DAOs and authorization scopes to retain
fresh time after real locks, client pinning and cleanup, JSONB readback, retention,
session rechecks, mutation rollback and single-connection release. SQL receivers
construct domain facts directly; they do not call the complete service workflow.

The original mixed service assertions remain until their receiving tests have
actually executed. Related database setup is reused within its explicit scope,
including mutation, rollback, independent readback and retry; all users and fault
objects are released before that environment closes. The
[Authenticator decision](2026-11-10-oauth-authenticator-test-boundary.md) and
[Maintenance decision](2026-11-10-oauth-maintenance-test-boundary.md) retain their
separate operation and lifecycle responsibilities. MetadataFetcher retains its
real TLS, HTTP, DNS, cache, concurrency and cancellation tests.

## Alternatives

**Mock only the DAO below service tests.** This still executes lower business
rules and cannot isolate failures or supply the direct operation's outcome.

**Replace mixed tests without receiving their unique assertions.** Supplied
mock outcomes cannot establish SQL locks, rollback or persisted state, and a
service callback recording a proposed write cannot establish commit.

**Move complete workflows into Store tests.** This relocates upper rules and
assembly work without assigning the query, transaction and persistence guarantees
to the mechanisms that own them.

**Use mutable global hooks or infer completion from callbacks.** Global hooks
couple instances; inferred completion hides unknown or failed transaction
outcomes. Instance binding and independently configured outcomes preserve those
separate facts.

## Consequences

Service tests execute without PostgreSQL or UniAuth fixtures while retaining
actual orchestration, completion precedence and result suppression. Receiver
costs remain part of the complete verification cost. A fixed sequence of related
service, Core, HTTP and PostgreSQL commands measures the net affected proof cost;
service package improvement alone does not establish a net or hosted CI gain.

The private operation collections add explicit dependency wiring. Strict
capability lifetime and constructor receiver checks make that wiring observable.
Real external mechanisms continue at their owners, including MetadataFetcher's
existing network cases. Shared fixture setup never replaces real commits,
independent reads, lock barriers or cleanup failures.
