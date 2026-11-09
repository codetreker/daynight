# Agent Note: Identity service tests follow direct operation ownership

Status: implemented

## Problem

Identity service tests combined SDK transport, transaction coordination, business
rules and PostgreSQL fixtures. Creating users, browser sessions and Personal Teams
to obtain fixed inputs repeated database setup in tests whose useful observation
was call order or a returned result. Some mixed cases also proved real row locks,
canonical owner uniqueness and atomic rollback, which operation mocks cannot
establish.

## Decision

The Identity service holds private typed operation bindings for its direct Core
Identity and Personal Team calls. Its production constructor binds the existing
Core implementations and clock. Tests replace these instance operations with
explicit results, refusals and errors, use opaque DAO capabilities, and reject
unconfigured or additional calls. They execute the service's actual transaction
callbacks with independently supplied completion and cleanup outcomes.

The service retains the actual UniAuth SDK and HTTP mechanisms: authorization URL
construction, callback parsing, upstream claims, response/error mapping,
cancellation and discovery. Profile normalization and encoding execute the real
protocol helpers. Operation results do not replace these I/O and encoding
mechanisms. Login consumption completes before upstream retrieval; local user,
Personal Team and session work receives capabilities from one scope. Failed final
completion returns only the consumed login's ID and destination. PersonalTeamID
retains its existing ID-plus-error behavior when completion fails after lookup.

Core Identity owns login and credential material, input bounds, token expiry
observations, device decisions, polling and hostname formatting. Core Personal
Team tests reject corrupt existing ownership without inserting a replacement
owner. PostgreSQL Identity tests own exact stored fields, database time, admission
serialization and driver errors. Root Identity scope tests observe canonical
users and owners across concurrent writes, unique login consumption, current
device and PAT rows after lock waits, and failed user/Personal Team/session writes
through fresh persisted readback. Store callbacks call DAOs directly and supply
refusals explicitly; they do not implement upper business decisions.

The [test-writing rules](../../../../docs/writing_tests.md) own layer allocation.
The [Identity architecture decision](../architecture/2026-11-05-server-identity-boundaries.md)
owns production ordering, scopes and error semantics. Normal fully assembled
HTTP authentication belongs to the existing API integration entry; its actual
selected flows determine what any run proves.

## Alternatives

**Keep the database fixture and mock only DAO calls.** The service would still
execute Core business matrices. Its feedback would remain coupled to unrelated
authentication, persistence and rule setup.

**Replace the SDK with static profile results.** This would erase real HTTP,
callback/schema parsing, upstream errors and cancellation observations that the
Identity service adapter owns.

**Move the entire mixed test workflow into Store.** This would preserve upper
Core and service calls beneath another directory and duplicate business logic.
Direct DAO witnesses preserve physical facts separately from the rules that
interpret them.

## Consequences

Ordinary service and Core Identity tests run without database or auth fixtures.
Real HTTP remains for SDK transport; physical PostgreSQL proof remains in Store.
Maintainers must preserve both layers when changing business decisions that
rely on locked current facts. A mocked refusal or committed outcome cannot stand
for SQL, durability or rollback. The constructor and normal API consumers retain
production defaults without public test constructors or global hooks.

Performance comparisons include receiving tests, fixed container budgets and
matching race/coverage/cache settings. Target-package reductions do not establish
complete-command or hosted CI savings. Source-bound validation owns measurements,
fault controls and delivery results.
