# Agent Note: Worker Native Tool Ownership

Status: implemented

## Problem

Native Agent inspection, Worker reporting and Bots depend on process ownership,
version probing and Codex configuration inspection. Locating these shared mechanisms
under the Herdr runtime makes retaining them dependent on a specific execution mode.

## Decision

The Worker owns these mechanisms in `owned-command.ts`, `native-version.ts` and
`codex-configuration.ts`. The shared owners remain independent of the retired Herdr runtime. The move preserves process-tree termination, bounded output and deadlines,
the original owner's close proof and error causes. Codex configuration argument
selection belongs with its RPC. Native selection uses the [Web-only model](../simplification/2026-11-18-web-only-native-tool-model.md).

The [native probe recovery decision](../bug-fix/2026-11-06-native-probe-cleanup-recovery.md)
retains its close-confirmation and recovery guarantees. The
[reporting design](../../../../docs/design/daynight-worker-reporting.md) owns the
current reporting mechanism.

## Alternatives

**Keep shared helpers in Herdr.** This would leave retained native and Bot
capabilities coupled to a runtime scheduled for removal.

**Introduce a new execution abstraction.** Existing owners already provide the
required mechanisms; another backend layer would add complexity without preserving
additional behavior.

## Consequences

Common callers can retain their process and configuration guarantees independently
of Herdr. Existing Herdr executions are not migrated; shared mechanisms and their tests remain.
