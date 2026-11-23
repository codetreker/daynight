# Agent Note: Task Data and Encoding Ownership

Status: implemented

## Problem

Task property storage, public write policy, ordered Step candidates and response
encoding were grouped in helper packages with different consumers. Storage must
read protected values without granting public writes, while admission and HTTP
output must share exact write-response bytes without making lower layers depend
on API types.

## Decision

`internal/core/model/taskproperty` owns the static property definitions and write
normalization codecs. Stored values load as canonical RawMessages; typed read
accessors decode the fields their consumer uses without repeat validation or
capacity admission. `internal/core/task/properties` applies public write policy
and the Worker/sessionStartup association using those definitions.
`internal/core/task/codec` owns Thread resource types and encoding. The
[application retirement](../simplification/2026-11-23-retire-task-steps-application.md) removes Steps projection,
exact collection encoding and strict candidate operations after public entry
retirement. Their original split separated pure stored projection from write
admission; PostgreSQL-dependent model and interface types remain with storage. The
[Task boundary](2026-11-05-server-task-boundaries.md) owns transaction and
permission orchestration. The
[canonical batch-read decision](../simplification/2026-11-09-task-canonical-batch-reads.md)
replaces stored-property validation and Step read-candidate codec reuse.

## Alternatives

**Keep the former helper packages.** Their mixed storage, policy and response
responsibilities obscured dependency direction and retained the Thread codec's
dependency on API types.

**Duplicate response encoders or property definitions.** Separate write admission
and output encoders could disagree on capacity or bytes, while duplicate
registries could diverge on normalized values and public write protection.

## Consequences

Protected values remain readable from storage and are rejected by public writes.
The former Step codec retained exact Encoder output with its newline and reserved
version budget for writes and pure projection for reads. Those responsibilities
leave with the Step application implementation. Thread keeps its independent
newline-free encoding and capacity rules. The split preserves one write registry
and encoding owner without compatibility forwarding packages. Task transactions
and permission orchestration use these helpers without repeating their definitions.
