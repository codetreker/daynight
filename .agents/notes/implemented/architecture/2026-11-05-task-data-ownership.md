# Agent Note: Task Data and Encoding Ownership

Status: implemented

## Problem

Task property storage, public write policy, ordered Step candidates and response
encoding were grouped in helper packages with different consumers. Storage must
read protected values without granting public writes, while admission and HTTP
output must share exact response bytes without making lower layers depend on API.

## Decision

`internal/core/model/taskproperty` owns the static property definitions, value
validation and storage codecs. `internal/core/task/properties` applies public
write policy and the Worker/sessionStartup association using those definitions.
`internal/core/task/codec` owns Steps and Thread response types and exact
encoding; API reuses its types. `internal/core/task/steps` owns ordered candidate
operations. The [Task boundary](2026-11-05-server-task-boundaries.md) owns transaction and
permission orchestration.

## Alternatives

**Keep the former helper packages.** Their mixed storage, policy and response
responsibilities obscure the dependency direction and retain the Thread codec's
dependency on API types.

**Duplicate response encoders or property definitions.** Separate admission and
output encoders could disagree on capacity or bytes, while duplicate registries
could diverge on valid stored values and public write protection.

## Consequences

Protected values remain readable from storage and are rejected by public writes.
Steps retain Encoder output with its newline and version budget; Thread retains
its newline-free encoding and capacity rules. The split preserves a single
registry and encoding owner without compatibility forwarding packages. Task transactions and permission orchestration use these helpers without
repeating their definitions.
