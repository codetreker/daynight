# Agent Note: Independent Task Steps read resource

Status: implemented

## Problem

Task stages must survive execution sessions and retain their own identities,
content and order. Loading large stage bodies through ordinary Task projections
would couple task lists, synchronization and lifecycle policy to unrelated data.
Readers also need one committed parent version and ordered collection, including
an explicit empty collection for existing tasks.

## Decision

Migration 030 stores normalized `task_steps` rows with a task-local eight-digit
lowercase hexadecimal identity, nonnegative position, independent four-state
status and microsecond timestamps. The primary key is `(task_id, id)` and the
position uniqueness constraint is deferred to permit atomic final-order updates.
The table follows existing task-property ownership without adding a foreign key.
Existing task rows and migration checksums remain unchanged.

The [resource contract](../../../../docs/spec/daynight-task-steps.md) exposes dedicated
collection and item HTTP resources. One repeatable-read snapshot performs normal
project admission, reads a narrow parent header and loads the requested Steps.
The header avoids hydrating properties, dependencies or execution policy.
Collection reads validate every row and dense order; item reads validate the
target within its declared Task. Soft deletion is checked after membership.

`internal/tasksteps` owns the public DTO and deterministic `json.Encoder.Encode`
bytes. The same bytes include escaping and the terminal newline, with capacity
reserved for a 19-digit parent version. Invalid storage fails the resource read.
Steps do not appear in Task, graph or synchronization payloads and reads preserve
all parent fields. A Steps-specific error classifier distinguishes a pure
business refusal from an error joined with a failed transaction cleanup. Safe
fixed diagnostics omit text, credentials, SQL and arbitrary driver messages.

## Alternatives

**Place Steps in the Task JSON row or full Task projections.** This makes content
and lifecycle access inseparable and expands list/synchronization payloads. An
independent resource keeps those consumers bounded by their existing contracts.

**Store one ordered JSON collection.** Array order is natural, but any later item
edit rewrites the complete collection and database integrity cannot distinguish
individual identities and positions. Normalized rows preserve those invariants.

**Reuse full Task loading or the Thread codec.** Full Task loading couples reads
to unrelated properties and execution policy. The Thread codec imports API DTOs
and omits the newline, while Steps needs a neutral resource owner and the exact
public encoding for capacity admission.

## Consequences

Old tasks naturally read as empty collections without backfill. Members can read
Steps regardless of Task state or session ownership. Complete reads remain
linear in collection size and can reach 64 MiB; ordinary routine CI excludes the
opt-in real HTTP capacity stress scenario. The dedicated single-item resource
loads only its target. The schema and codec also serve
[atomic collection additions](2026-11-04-task-steps-atomic-add.md), which preserve
this read resource and its existing snapshot and capacity guarantees.
