# Agent Note: Remove MCP Output Schemas

Status: implemented

## Problem

MCP maintained a separate JSON Schema for every result in addition to the Go
result types and protocol tests. Registration and runtime validation repeated
that contract, and an output mismatch after a committed write could turn an
otherwise encodable response into an error. Discovery no longer exposed these
schemas, so the internal definitions added maintenance cost without serving
discovery.

## Decision

MCP registration compiles and validates input schemas but does not define,
compile or validate output schemas. Tool discovery continues to omit
`outputSchema` without moving it to another field or Resource. Go result types
and protocol tests that directly assert actual structured results own result
correctness. The [private result contracts decision](2026-11-16-private-mcp-result-contracts.md)
records the earlier choice to omit public schemas while retaining internal ones.

Encoding and response-delivery failures retain their established error chains,
completion facts, phases, request IDs and encodable references. Applicable
write and upload output-size admission remains independent of schema validation;
ordinary reads retain their ordinary encoding policy and dedicated Session page
and body budgets remain in their owners. Input validation, resource permits,
deadlines and authorization are unchanged. The [MCP entry decision](../architecture/2026-11-06-mcp-http-entry.md)
and [response budgets decision](../architecture/2026-11-07-encoded-response-budgets.md)
record the surrounding boundaries. The [protocol test ownership decision](../testing/2026-11-09-mcp-use-case-test-ownership.md)
records the tests' responsibilities.

## Alternatives

**Keep internal output schemas.** Registration and runtime checks would continue
to require a second complete description of each result, including error
envelopes, even though discovery does not expose it. A mismatch after a committed
write could still change the response to an output error.

**Migrate tests separately or remove definitions by tool family.** A separate
test migration would leave a temporary duplicate contract and require repeated
validation. Splitting by family would retain different policies at the shared
registration boundary until every family was migrated. Removing the mechanism,
definitions and affected assertions together keeps one coherent result policy.

## Consequences

Protocol tests must assert required fields, types, nulls, pagination and write
completion facts directly; neither Go types alone nor a nonempty result proves the
wire contract. There is no runtime schema-based rejection of a mismatched output,
including after a committed write. Real JSON encoding and delivery failures, and
applicable capacity refusals, continue to be observable. Clients still cannot
derive output types from discovery metadata.
