# Agent Note: Chunked Worker configuration checkpoints

Status: implemented

## Problem

A configuration checkpoint retains current and historical application facts. Their
combined JSON can exceed the JavaScript single-string limit even when each value
is valid, preventing startup, migration, or a later durable commit. Cache reads
must also retain their strict syntax and identity checks.

## Decision

The Worker reads one file through a fatal UTF-8 decoder and a cache-specific
incremental syntax guard before parsing with the pinned `@discoveryjs/json-ext`
1.1.0 JSON codec. It validates the complete object and identity at EOF and closes
the read handle before migration. Commits freeze the queue's snapshot and create
an iterator for each write attempt. A same-directory exclusive temporary file is
written completely in order, synced and closed before atomic replacement.
Schema 1–3 upgrades and schema 4 retain the existing business validation and
failure semantics. The [Worker design](../../../../docs/design/daynight-worker.md)
owns the current cache behavior.

## Alternatives

**Whole-file JSON encoding and parsing.** This preserves the existing code path
but fails once the accumulated checkpoint exceeds a single runtime string.

**Record arrays, multiple files, or SQLite.** A new container still requires a
migration of potentially large old values. Multiple files require a manifest and
crash-safe collection; SQLite changes the existing persistence owner. Neither is
needed to remove the aggregate text limit while keeping one atomic replacement.

## Consequences

The codec and guard add a pinned dependency and incremental syntax state. A
single token is still limited by the runtime, and retained objects require memory
proportional to their facts. Strict validation remains necessary because the
codec alone accepts duplicate keys and noncanonical numbers. Retrying transient
storage failures is a separate concern; a fresh iterator can reproduce a frozen
snapshot without repeating business updates.
