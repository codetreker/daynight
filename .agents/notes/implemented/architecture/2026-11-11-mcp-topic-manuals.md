# Agent Note: Read MCP Product Guidance by Operation

Status: implemented

## Problem

The product Resources were independently readable, but their broad boundaries
mixed Task, Step, Thread and Session operations in one query guide. Session
inspection required the entire 31,431-byte query document. Shared rules also had
multiple detailed owners, allowing creation defaults and completion guarantees to
diverge. New grouped work and ephemeral Session observations lacked discoverable
guidance.

## Decision

The server embeds twelve complete English operation guides and one short
initialization instruction. The purpose index and Resource descriptions identify
the required topics. Common write safety has one detailed owner; operation guides
retain their specific versions, identity, pagination, integrity and recovery rules.
Material organization keeps information ownership and sufficiency separate from
Step, Thread and transfer protocols.

The fixed `productManualManifest` owns production paths, public metadata and
strict content sizes. Loading and registration use that inventory; tests assert
the expected public URI set independently. Instructions and topic references use
absolute Resource URIs, and invalid or incomplete sources fail before registration.
The topics remain the only edited content source; no aggregate or runtime link
conversion is required.

The existing concepts, dependencies, write-safety and materials URIs remain.
Independent guides replace queries-and-lifecycle, files-and-references and
operation-boundaries. Clients rediscover the catalog after updating the server;
removed URIs receive the existing unknown-resource error. The
[original Resource decision](../feature/2026-11-09-mcp-product-manuals.md) still
owns embedded publication, authenticated access and the Control delivery lifetime.
The [server design](../../../../docs/design/daynight-server.md#http-传输准入)
records those unchanged transport mechanisms.

The guidance describes current MCP schemas and results, including typed Task/Goal
reads, ordinary-only creation, grouped-work continuation, nullable Session
observations and completion no-ops. CLI pre-reads, prompts, local recovery files
and repository delivery workflows do not define MCP behavior.

## Alternatives

**Keep the broad Resources and navigate by heading.** A heading locates text but
does not create a separate `resources/read` unit. Unrelated operations still enter
the caller's context, and the large guides obscure required local conditions.

**Keep complete technical explanations in material and query guides.** Those
copies must evolve with each protocol change and already disagreed about Task
creation defaults. A single detailed owner plus essential local reminders makes
the required reading combination explicit.

## Consequences

Callers can read the operation guides they need, including shared safety, without
extracting sections from larger mixed resources. Catalog growth makes Resource
descriptions and reading prerequisites part of usable navigation. Benefits must
be measured using all required topics for the same operation, together with entry,
catalog, schema and round-trip costs; source length alone does not establish model
token or execution savings.

URI replacement is a consumer-visible catalog change. Current documentation and
tests must agree with the published set, while archived decisions retain their
historical boundaries. Topic updates still ship with the service, and content,
metadata and tests must remain synchronized.
