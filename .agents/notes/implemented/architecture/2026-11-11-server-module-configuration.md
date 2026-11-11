# Agent Note: Server Module Configuration Ownership

Status: implemented

## Problem

A single flattened startup configuration owns fields and rules for unrelated
modules. Changes to a module require changes to the shared schema and couple
HTTP, service, and storage callers to configuration they do not own.

## Decision

Each owning module defines its configuration, defaults, environment decoding and
pure validation. The root configuration aggregates those types, loads the
existing environment interface, and invokes cross-module rules. HTTP origin and
callback validation remains a pure HTTP authentication rule. Configuration
errors and scalar decoding live in a neutral utility and retain safe messages and
cause chains. Application assembly passes the relevant values to consumers.

## Alternatives

**Keep a flattened global configuration.** This makes every module's fields and
rules part of a shared schema and requires unrelated consumers to depend on it.

**Maintain a flattened compatibility projection.** This duplicates field
ownership and leaves two schemas to synchronize during subsequent configuration
work.

## Consequences

Module rules and defaults can evolve with their owners without a dependency on
the aggregate. The aggregate still coordinates checks involving multiple
modules. Environment-only startup, empty-value defaults, and the working-directory
base for relative storage paths remain unchanged; layered files and a shared
root are separate work. The [server design](../../../../docs/design/daynight-server.md)
describes the current assembly.
