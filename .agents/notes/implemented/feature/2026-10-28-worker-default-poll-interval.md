# Agent Note: Worker Default Poll Interval

Status: implemented

## Problem

A worker that omits its polling interval repeatedly reads service state every
five seconds after reconciliation, even when no work changes. The default must
balance idle polling traffic against the delay before discovering new work or
observing changed claims.

## Decision

`workerConfigurationDefaults.pollIntervalMs` is 60000 milliseconds. Missing
configuration, an omitted worker mapping and omitted interval fields share this
single default. The runtime keeps waiting after each reconciliation round, so
the time between round starts also includes the duration of the preceding round.
The [foreground runtime decision](../architecture/2026-10-27-foreground-worker-runtime.md)
owns configuration omission and runtime composition.

Explicit valid intervals retain their configured values, including 5000.
Configuration reads do not migrate or rewrite files, and the existing positive
safe-integer timer validation remains in force. Review polling, native-agent
observation and other timers retain their independent settings.

## Alternatives

**Keep the five-second default.** It discovers new work sooner but retains the
higher idle request frequency that the sixty-second default is intended to
reduce. Explicit configuration remains available when that shorter delay is
needed.

## Consequences

Omitted settings wait sixty seconds after each round, reducing idle polling
frequency while increasing potential discovery and reconciliation latency.
Existing explicit settings keep their timing. Running or installed workers need
the updated CLI and a restart to use the new source default; this configuration
change does not upgrade them or add hot reload.
