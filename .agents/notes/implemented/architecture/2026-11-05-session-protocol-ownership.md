# Agent Note: Session Protocol Ownership

Status: implemented

## Problem

Session admission, transport and future business modules need the same strict
wire types and encoding rules. Coupling those contracts to an implementation
would make their shared use and dependency direction difficult to preserve.

## Decision

The v1 and v2 Session types and their codecs live together under
`internal/core/session/protocol`. Generic strict JSON object and Unicode helpers
live under `internal/utils`. Consumers import these owners directly. The Go
protocol tests continue to use the TypeScript Session fixtures.

## Alternatives

**Retain the former top-level packages.** This leaves the Session protocol
outside its final domain location and obscures the distinction between domain
contracts and generic JSON helpers.

## Consequences

The protocol packages do not depend on the Session engine, storage, service or
HTTP layers. The move preserves protocol bytes and decoding rules. Session
engine and archive operations remain with their current owners until their own
reorganization; no compatibility packages or duplicate implementations are
needed.
