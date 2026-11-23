# Agent Note: Retire REST Task Steps

Status: implemented

## Problem

Task Steps exposes an independent ordered resource through collection, item,
status and position HTTP paths. Once Web and CLI consumers have retired and
Steps Webhook capture has stopped, keeping those routes leaves a callable
product capability with its own DTOs, scope mapping and CORS registration.
Ordinary Task, Thread and attachment behavior must remain independently usable.

## Decision

REST registers no Steps routes, handlers, input/output DTO aliases, scoped
operation mapping or CORS methods. Old GET, HEAD, POST, PATCH, DELETE and PUT
requests use the existing unknown API path, including preflight rejection.
They cannot reach the SPA or ordinary Task handler, read or write Steps,
advance a parent version or capture an event. No dedicated retirement adapter
or successful empty resource remains.

The REST retirement originally retained the shared Steps application and
persistence owners. The [application retirement](2026-11-23-retire-task-steps-application.md) removes
Application and scoped assembly, Service, Core candidates, codec and input policy.
The subsequent [storage retirement](2026-11-23-retire-task-steps-storage.md) removes the DAO interfaces and code; [data retirement](2026-11-23-drop-task-steps-data.md) deletes the rows and table. Historical
migration checksums and saved credential scopes retain their existing rules. Shared Thread
encoding, ordinary Task authorization and mutation behavior retain their owners.

The [resource requirements](../../../../docs/spec/daynight-task-steps.md) and
[design](../../../../docs/design/daynight-task-steps.md) define the current
boundary. This completes the public HTTP exit after the independent
[Web](2026-11-23-retire-web-task-steps.md),
[CLI](2026-11-23-retire-cli-task-steps.md),
[MCP](2026-11-23-retire-mcp-task-steps.md) and
[Webhook](2026-11-23-retire-step-webhook.md) decisions. It supersedes the HTTP
consumer and HTTP proof portions of the
[scope admission](../architecture/2026-11-20-steps-thread-scope-admission.md),
[component test ownership](../testing/2026-11-11-go-component-test-ownership.md)
and [dependency boundary](../testing/2026-11-08-go-test-dependency-boundaries.md)
decisions; their surviving Thread, ordinary Task and Store rules remain.

## Alternatives

**Keep hidden routes or a dedicated retirement handler.** Hidden registration
would retain callable operations. A special rejection handler would add a new
API contract and authentication behavior when the existing unknown API path
already rejects unsupported resources.

**Delete the internal service or table with REST.** That would combine public
protocol removal with separate application, storage and irreversible migration
changes. Keeping their ownership separate allows each change to retain its
own focused persistence and rollback evidence.

## Consequences

Old Steps HTTP clients receive an explicit failure. Runtime tests observe
retired method, HEAD, preflight and SPA behavior and zero Steps calls. Candidate
service evidence binds public status codes and unchanged parent versions to the
actual source and build. Ordinary Task, Thread and attachment authorization and
soft-deletion proofs use their own fixtures.

HTTP-specific CRUD, timeout, response and capacity tests leave with their
handlers. Steps Service, Core and codec tests leave with the application implementation;
PostgreSQL tests retain the behavior they still own. A rejected route does not establish that persisted data has been
deleted or that a production release has occurred.
