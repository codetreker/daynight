# Agent Note: Go Component Test Ownership

Status: implemented

## Problem

A mandatory direct-operation mock boundary can make every layer a separate
fixture even when real collaborators are inexpensive and deterministic. It can
also duplicate lower interfaces and test setup while obscuring the cost of the
receiving suites and the behaviors that cross a useful component boundary.
Conversely, an unrestricted full application fixture brings unrelated modules,
resources and cleanup into tests whose subject is a narrower protocol or rule.

## Decision

Tests choose their component boundary from the behavior being proved and the
cost of preparation, execution and cleanup. Inexpensive, deterministic Handler,
Service and Core collaborators can run together. Expensive or uncontrolled
collaborators, and capabilities requiring precise outcomes, errors, blocking,
ordering or cancellation, are controlled narrowly. Real SQL, file, SDK, socket,
authentication protocol and lifecycle mechanisms remain real when they are the
subject. Mocks do not establish persistence or replace parsing, encoding or the
mechanism under test.

Task HTTP reads, writes and sync run with their real Task components and
narrowly controlled snapshot and project-write capabilities. Task deletion
retains a Root cross-route tombstone proof. The Task assignee stress sample
retains the real application, SQL capture and query plans at the Task adapter.
Step and Thread HTTP scenarios use their real registrars and services with
controlled DAO facts; file-effect witnesses use local files. Root retains the
assembled Step-to-Attachment authorization proof.

Go tests live in the package and directory of the tested object, normally in
`xxx_test.go` for `xxx.go`. Files over about 1000 lines may be split by cohesive
responsibility, and small related helpers are consolidated. Before removing a
scenario, its receiving test must execute and retain its unique guarantees,
including tags, errors and cleanup. Matched cost comparisons include the Root
and receiving packages and their preparation and cleanup; moving time between
packages is not itself a saving.

The Root fixture retains its existing shared names and semantics for ordinary
and tagged consumers. Configuration rules and WebUI protocol matrices belong
with their implementations, while Root retains real assembly, route coexistence
and protected API proofs. Worker HTTP protocol matrices live with their Worker
registrar, with real Service and Core where appropriate and narrow controlled
capabilities for precise outcomes; HTTP fault classification belongs to httpx.
Project and Team HTTP organization scenarios use their real registrars and
Service/Core with controlled DAO facts. Project, Team and Invitation MCP
scenarios use a focused Entry host with those real collaborators and the SDK;
Root retains full catalog, default authentication and cross-route proofs.
Step MCP lifecycle scenarios use the same focused host with controlled Step
operations, and Thread scenarios retain the real service with controlled DAO
facts. The separate Step stress test uses PostgreSQL and real Step services.
The earlier [Root Step operation boundary](2026-11-10-root-mcp-step-operation-boundary.md)
records why those operation-level observations were introduced.
The Webhook Runner process-recovery and takeover witnesses live with the Runner
and retain real PostgreSQL, TLS, subprocess and lease fencing mechanisms under
their existing explicit tags. The [takeover fixture decision](2026-11-08-webhook-takeover-fixture.md)
records its timing constraints. The [test-writing rules](../../../../docs/writing_tests.md)
own the current requirements.

## Alternatives

**Require direct-operation mocks at every layer.** The earlier
[dependency boundary decision](2026-11-08-go-test-dependency-boundaries.md)
used this to make adapter and coordination failures independent of lower
business decisions. Applied universally, it also replaces useful inexpensive
collaboration and adds interfaces and fixtures without regard to the behavior
or total cost under test. Existing targeted mocks remain useful where their
precision is needed.

**Use complete application fixtures for every test.** This exercises unrelated
construction and resources, increases cost, and makes faults harder to locate.
A real application remains necessary for its assembly and end-to-end proofs.

## Consequences

A test can cover a coherent component without mechanically mocking each layer,
but its assertions must still identify the behavior and failures it proves.
Tests of controlled results cannot prove physical persistence; real database,
API integration, process and product E2E obligations remain. Cost improvements
require matching source, resource, cache and coverage conditions across the
complete affected set; moving a test is not evidence of faster CI.
