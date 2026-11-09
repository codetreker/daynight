# Test-Writing Rules

Assign tests by the behavior they prove. CLI, Web and Go each own their module's normal behavior, boundaries, errors and concurrency guarantees. Go server unit tests mock the directly invoked service or business use case. Service and core unit tests isolate dependencies outside their own responsibility. Store contract unit tests construct inputs directly; DAO implementation tests verify real PostgreSQL. Go API integration and independent product E2E tests cover representative normal flows only.

This document owns test responsibilities, dependency boundaries and migration conditions. `docs/development.md` and module READMEs own executable commands, environment requirements and CI configuration. The directories and entry points specified here are organizational requirements; verify their actual implementation, runners and CI selection through source and execution results.

## Test Responsibilities

| Layer | Verified behavior | Dependencies and execution |
|---|---|---|
| CLI module tests | Arguments, configuration, request construction, output, client state, error handling and local mechanisms | Controlled product API responses; real resources when testing local mechanisms |
| Installed CLI tests | Packaging, installation, bundled resources, command entry points, runtime and platform compatibility | Real installed packages on Linux, Windows and macOS ARM64; controlled fixtures for product HTTP services |
| Web module tests | Components, interactions, state, caching, response handling, asynchronous races and browser behavior | Controlled product API responses; frontend-only fixtures when a real browser is required |
| Go server unit tests | Routing, HTTP request parsing, argument propagation, response encoding, error mapping, protocol authentication and request lifetime, including boundaries, errors and races | Mock the directly invoked service or business use case, with controlled identity dependencies; execute the real HTTP adapter without a real database |
| Go service unit tests | Cross-module orchestration, dependency assembly and shared-resource lifetime, including call order, errors and completion outcomes | Mock orchestrated lower operations and required DAO, scope, transaction and external-resource boundaries; no real database |
| Go core unit tests | Module business rules, permissions, state transitions and operations, including boundaries, errors and races | Synthetic domain data and required DAO mocks for data-access results; no real database |
| Go store contract unit tests | Database-independent interface capabilities, pure functions and error contracts | Directly constructed inputs; no database or concrete driver dependency |
| Go store implementation tests | SQL, mapping, persistence, constraints, locks, snapshots, transactions and migrations, including boundaries, errors and concurrency guarantees | An isolated real PostgreSQL instance; DAO mocks cannot replace database mechanisms |
| Go API integration tests | Normal feature flows through a fully assembled Go Server | A real Go Server process, HTTP requests and isolated PostgreSQL, driven sequentially by Go HTTP clients |
| Product E2E | Normal flows connecting the complete CLI, Web, Server and persistence | Linux only; build the complete Server, CLI and production Web from the same source revision and run them with real PostgreSQL in an isolated environment |

Using real HTTP, a browser, a database or a subprocess does not itself make a test product E2E. Browser layout tests with controlled API responses belong to Web; PostgreSQL lock and transaction tests belong to Go store implementations. Ownership follows the behavior being proved and the dependency restrictions of that layer.

A "real database" means a PostgreSQL instance actually started inside an isolated test environment. That environment owns preparation, bounded readiness and cleanup, including the data directory and connection configuration. Do not connect to an existing development, shared or production database. Separate schemas inside a shared instance do not satisfy this environment-isolation requirement.

## Module Tests

CLI, Web and Go must verify complete behavior in their unit and owned mechanism tests, including applicable normal operations, invalid input, capacity boundaries, permission refusals, timeouts, cancellation, version conflicts, concurrency and recovery. Go API integration and product E2E cover normal flows, without taking over these boundary, fault or race matrices.

Place assertions with the implementation that can explain their failure. Tests may use several packages in the same product module, but must respect their layer's dependency restrictions. Mocks control collaborators outside the tested responsibility; they cannot replace the parsing, encoding, timing, I/O or resource-lifetime mechanism under test. Pure functions use directly constructed inputs, without extra dependencies introduced merely to support mocks.

### CLI

CLI tests own command parsing, configuration, request headers and bodies, pagination, output, exit status, operation deadlines and service-response handling. Controlled HTTP fixtures verify authentication errors, conflicts and unknown outcomes without starting Go Server or Web.

Use real resources when testing local Git, SQLite, filesystem, terminal or subprocess mechanisms. HTTP fixtures cannot replace the local mechanism being verified.

### Web

Controlled API responses, Promises and clocks verify rendering, interaction, client state, identity changes, caching, error presentation and asynchronous races. Browser-dependent focus, history, layout, scrolling and text selection use frontend-only browser fixtures.

Web module tests do not start Go Server, prepare PostgreSQL or install CLI. Web tests prove how the frontend handles API results; Go tests prove how the server produces them.

### Go server

Follow the server organization rules in `docs/daynight-server.md`. Server unit tests execute production routing, request parsing, DTO conversion, response encoding and error mapping. Configure return values, domain errors, completion outcomes and controlled blocking at the service or business-use-case boundary directly invoked by the handler. A handler calling core directly is isolated at that use case too; mocking only DAO access while running real service/core decisions does not isolate the HTTP adapter's responsibility.

Verify exact propagation of principal, canonical IDs, input, protocol headers and context, including call counts and required order. Protocol refusals must verify that the lower business operation was not called. Normal domain results and refusals separately verify HTTP status, headers, response content, log classification and redaction. Core or service tests own the business rules themselves.

Authentication middleware executes real HTTP authentication parsing and uses controlled identity dependencies to return a principal or authentication error. Ordinary resource-handler tests must not start real UniAuth, run complete login/PAT flows or assemble the full application merely to prepare identity. API integration tests verify real authentication in normal fully assembled flows.

Preserve server-owned request deadlines, cancellation propagation, short or lost responses, cancellation before body handling, background-operation exit and cleanup. Observe that the mock operation has started, or establish that fact with a barrier, before cancellation or deadline delivery. Necessary socket and ResponseWriter behavior uses real mechanisms. Mock `committed`, `not_committed` and `unknown` values are supplied lower outcomes, not proof of a real commit, rollback or persistence. Server tests still verify logs and business-call counts after response failure.

Exact HTTP input and server-owned response envelopes, newlines and encoded page capacities must pass through the real parser or encoder. When service supplies an encoded Document/JSON result, server tests verify transmitted bytes, headers, short writes and cancellation; the producing service or pure protocol package verifies byte generation and admission. Graph node/edge limits, domain-field admission and other business capacities belong to their rule owners. Store tests verify actual query and storage capacity mechanisms.

### Go service and core

Core unit tests use synthetic domain data to verify module rules, permissions, state transitions and operations. Required query results, storage errors or transaction outcomes are controlled through the module's `core/store` DAO, scope and transaction mocks, with checks for arguments, calls, results and error chains.

Service unit tests verify orchestration, assembly and shared-resource lifetime. Orchestrated lower business operations and external resources use controlled dependencies. Transaction coordination tests execute the actual callback through DAO, scope and transaction mocks, separately configuring the operation result, completion outcome and cleanup errors. Do not repeat lower business-rule matrices in service tests.

Mocks implement only the capabilities needed by the current test. Unconfigured or extra calls must fail the test, including independently reported background calls followed by cancellation and drain. Callback execution, proposed write arguments and `committed`, `not_committed` or `unknown` outcomes remain separate. A recorded write is not persistence, and an unknown outcome cannot be interpreted as rollback. Do not mock SQL strings or build a complete in-memory PostgreSQL substitute.

These unit tests must not connect to a real database or start PostgreSQL to obtain fixed domain data. Selected core, service and server units must actually execute with `DAYNIGHT_TEST_DATABASE_URL` unset; skipped tests and default empty results do not establish isolation. Ordinary Task HTTP `TestMain` clears database and UniAuth fixture variables before running its complete suite, so full Go validation cannot lend that package infrastructure intended for other owners. The separate stress entry does not use this `TestMain`. Pure logic without data-access dependencies needs no DAO mock.

### Go store and process mechanisms

Database-independent `core/store` interface capabilities and pure-function contracts are tested in the contract root package with directly constructed types, errors and results, without PostgreSQL. DAO implementation tests must use isolated real PostgreSQL to verify SQL, mapping, persisted readback, constraints, locks, snapshots, transaction commit and rollback, migrations and their boundaries, errors and concurrency. DAO mocks cannot replace the database. These tests do not own upper business rules or complete API flows.

Organize DAO tests by the actual implementation owner. Domain queries, mapping, constraints and locks follow the DAO child package. The implementation root retains its connections, migrations, scope construction, transaction completion, cross-DAO atomicity, shared snapshots and resource release. A root database fixture, `Open` or scope entry does not make a domain assertion a root responsibility. Independent business rules remain in core or service with their required mock boundaries.

Split mixed files by independent proof. Retain the setup and persisted observations necessary for a real scope, snapshot or rollback proof. Move independent query, business-rule and contract matrices to their owners. Consolidate small files by a shared responsibility while preserving existing inputs, assertions, fault detection, cleanup and build tags. File length and equal test names do not establish equivalent coverage. Confirm receiving-package discovery and execution before removing the proof from its original location.

Shared fixtures receive required DAO or scope capabilities through existing contracts; raw SQL tools receive an explicit pool. Backend-opening factories remain with consuming tests, and public fixtures do not depend back on the DAO implementation root, avoiding test import cycles. Fixtures may call existing production operations to prepare valid facts, but must not copy business decisions or build an automatically evolving storage model. Callback execution remains distinct from actual completion and subsequent persisted readback.

Actual database query cancellation, connection release, lock order, lost commit confirmation, cross-operation reads and consistency are proved by the store implementations that own them. Upper cancellation propagation and mock transaction outcomes cannot replace this evidence.

Process startup, shutdown, migration and recovery mechanisms belong to their process or runtime tests, using the real processes and resources needed to prove them. Their errors and races remain with the mechanism owner; they do not move into the normal-flow-only `cmd/integration_tests` suite.

These Go tests do not install or execute CLI, or run Web tests. Preparing production Web resources needed for Server embedding is a build dependency, not permission for Go test commands to invoke Web tests.

## Go API Integration Tests

Go Server API integration tests live in `packages/daynight-server/cmd/integration_tests/`, use the explicit `integration` build tag, and run through `scripts/integration.sh` after a production Server build. They are Go module validation, separate from ordinary unit discovery and independent product E2E. The server README and development guide own executable commands, production-resource preparation and cleanup.

Start a real Go Server process, PostgreSQL instance and attachment storage in an isolated environment. Drive the service through Go HTTP clients and assert public responses and observable results. Requests must pass through real routing, authentication, service assembly, DAO and persistence. Do not replace DAO or product API behavior with mocks, or use CLI/browser drivers. Production Web resources are a Server build dependency; these tests do not drive Web interactions.

Choose representative normal success flows for each feature, with valid input, ordinary resource sizes, normal authorized identities and sequential operations. For example, create a Project and Task, read and modify the same Task, then complete it. Step, discussion and attachment features verify basic successful reads and writes. Subsequent requests read the same resource and content to confirm the real chain works. Identity, resource IDs, versions and content must correspond; success or HTTP status alone is insufficient.

Do not expand this suite into invalid input, capacity boundaries, permission refusals, conflicts, races, fault injection or recovery matrices. Unit, store or process tests own those guarantees. Normal authentication and authorization may be flow steps; refusal, expiry and revocation remain at their owning layer.

Bounded readiness, execution deadlines, failure diagnostics and resource cleanup remain mandatory. These runner guarantees do not add abnormal business scenarios. The runner's own failure behavior is tested as tooling.

### Conditions for Migrating Existing Tests

Evaluate scenarios and assertions individually, not by filename, database use or whether a request once succeeded. Only representative success flows proving normal collaboration through the complete API chain belong here:

- Normal identity and valid data create, read and modify the same resource, with later API requests confirming the result.
- Normal Task status progression and basic successful Step, discussion and attachment reads and writes.
- A small normal dataset for filtering, pagination or dependency reads verifies the fully assembled request path.

Split tests mixing normal flows with boundaries, refusals, conflicts, races, faults, cancellation or response loss by proof responsibility. Normal flows may move to API integration; protocol assertions use server mocks, business rules remain in core/service, actual SQL, transactions, locks and persistence faults remain in store, and process faults remain with their runtime owner. Stress and capacity workloads use independent entries.

Before migration, identify the final owner of every unique guarantee and preserve valuable input, assertions and fault detection. Similar test names or passing coverage do not establish equivalent proof. Do not expand every normal branch into an integration matrix or duplicate the same rule matrix in API integration and product E2E.

Receiving runners, discovery, commands and CI selection must actually execute, with verified results. A missing, unselected or unexecuted destination suite must not reduce original defect detection. Before removing a scenario, complete proof preservation in the receiving layer and its corresponding rule owner. Performance evaluation includes the receiving layer and complete validation cost.

## Installed CLI Tests

Actually package and install CLI, then execute installed `daynight` and `dn` entries to verify delivery properties that source tests cannot prove: package contents, production dependencies, bundled resources, command entries, runtime loading and platform-specific behavior.

Run installation validation on Linux, Windows and macOS ARM64. Node.js runtime compatibility and shell integration belong to CLI artifact and platform validation.

Product API dependencies use controlled HTTP services. Requests pass through real sockets and the actual installed client, with fixture-provided responses. This proves installed-client behavior, not connectivity to the real Go Server and PostgreSQL.

Choose representative commands for artifact validation. Complete argument, response, boundary and race matrices stay in CLI module tests. Product E2E verifies business connectivity between real clients and the actual product service.

## Product E2E

Product E2E lives in `packages/e2e_tests`, with the explicit `pnpm e2e:test` entry separate from CLI, Web and Go module tests. Run one Linux topology. Build the complete Go Server and CLI and production Web from the same source revision, assemble those artifacts into the complete system, and start real PostgreSQL and auth in an isolated environment. Drive the built CLI and production Web through a browser.

The environment owns its database instance, data directory, attachment storage, configuration and processes, including preparation and cleanup. Server uses the complete product entry, CLI executes the built program, and Web uses production artifacts. Source function calls, partial module hosts and mocked product components cannot replace the complete system. Installed CLI tests own packaging, installation, command entries and multiplatform compatibility.

Use real product APIs and normal authentication, including browser login and CLI device login. Start the complete auth implementation inside the isolated environment. When an external identity provider is needed, use an environment-owned controlled provider supplying normal identity; runtime must not depend on external services or accounts. Do not mock product APIs or replace production Web with frontend fixtures.

Keep only a few sequential flows with valid data and ordinary resource sizes:

1. Browser login and CLI login.
2. CLI creates a Project and Task; Web reads the same Task.
3. Web changes Task status; CLI reads and completes it; Web verifies the result.
4. Step, discussion and attachment each have one basic successful write/read chain, read by the other client.

Cross-client assertions verify resource identity and actual content, not command success or HTTP status alone. Another client reads committed data; when applicable, refresh the browser to verify persistence.

Do not expand these flows into boundary, refusal, expiry, conflict, race, fault-injection or recovery matrices, or repeat business matrices by operating system, topology, role, language or file format. Module, artifact and deployment tests own those guarantees.

## Ownership Examples

| Guarantee | Owner |
|---|---|
| CLI sends the correct version and reports a conflict accurately | CLI module test with controlled HTTP responses |
| Server encodes a service version conflict as HTTP 409 | Go server unit test with a mocked service result and real error mapping |
| Server rejects an invalid body without invoking business work | Go server unit test with real parsing and mock-call assertions |
| Core rejects a version mismatch or unauthorized operation | Go core unit test with DAO-controlled data and results |
| Service preserves the lower error chain and completes its scope correctly | Go service unit test controlling lower operations and scope/transaction outcomes |
| Locks and transactions prevent two writes for the same version from both committing | Go store implementation test with real PostgreSQL and deterministic concurrency coordination |
| HTTP cancellation reaches the invoked business use case | Go server unit test observing mock-operation start, then cancelling and draining |
| PostgreSQL query cancellation releases query and connection resources | Go store implementation test observing actual SQL before cancellation and resource checks |
| HTTP creates, reads, modifies and completes the same Task | Go API integration test through the real Server and database normal flow |
| Web presents a conflict without replaying the write | Web module test with controlled responses |
| Installed Windows command entry finds bundled resources | Windows Installed CLI test |
| CLI-created Task appears in Web; a Web modification is read by CLI | Linux product E2E |
| Deployment backup and restore preserve attachment files | Deployment integration test |

A feature may have tests at several layers, but each must prove a different responsibility without duplicating complete behavior matrices.

## Runners and Infrastructure

Module test commands must not invoke another product module's tests or implicitly run product E2E. Installed-artifact validation, module browser tests, Go API integration, product E2E, deployment tests and tool tests each need explicit entries with clear responsibilities.

Product E2E has an independent Linux CI job selected by its framework and actual build inputs. Module tests retain their own jobs. A selected E2E job must actually succeed for the final gate: failure, cancellation or unexpected skipping cannot count as success. Unaffected changes may skip it through change selection.

Every runner needs bounded readiness and execution deadlines, propagated preparation/test failures, useful diagnostics and cleanup of owned resources. Clean up after success, failure and cancellation, including services, browser processes, isolated databases, storage and installed fixtures. CI must reserve cleanup time and independently check the run's resources after test termination. Cleanup success cannot erase the original test failure.

CI uploads results, logs and necessary failure screenshots or traces, without private configuration, credentials, database files, attachment storage, certificates or copied build artifacts. Caches only prepare dependencies; every selected E2E execution rebuilds and tests current source.

The runner's own timeout, cancellation, failure propagation and cleanup are tooling tests; their verification does not require adding fault-injected business flows to product E2E.

Use observable conditions, controlled clocks or synchronization barriers suited to the mechanism. Module and store concurrency tests observe the target operation or lock before triggering the next action; an arbitrary wait cannot prove that a race was exercised. Ordering assertions cover the same logical operation or explicit barriers, without requiring global FIFO across goroutines. Retry only operations whose semantics permit it; retries must not conceal failed assertions or unknown write outcomes.

Stress, capacity and performance workloads use separate local commands. Ordinary CI unit, integration and product E2E suites do not execute stress cases; bounded deterministic concurrency tests remain module validation.

Choose validation from affected behavior and dependencies. Mocked server, service and core units cannot prove database mechanisms or complete API connectivity. Store tests cannot replace upper rules or protocols; normal API flows cannot replace module/store boundaries and concurrency; product normal flows cannot replace these layered guarantees.
