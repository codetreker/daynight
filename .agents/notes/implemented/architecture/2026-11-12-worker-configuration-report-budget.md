# Agent Note: Worker Configuration Report Budget

Status: implemented

## Problem

A legal applied native configuration can exceed the old 1 MiB report body
limit by itself: JSON escaping 128 arguments of 4096 bytes each can make a
single result larger than the entire request allowance. The Worker cannot
report that result faithfully even when it fits the independent stored
observation budget. Required configuration and inventory cannot be truncated to
make the request appear successful.

## Decision

Reports selecting configuration protocol 1 or 2 use a 9 MiB encoded request
limit. Reports without that protocol retain 1 MiB. The server validates the
protocol header before selecting the limit; the client uses the same limit for
optional tool-path and runtime-configuration projection and for the final
encoded body. The [snapshot contract](../../../../docs/spec/daynight-worker-snapshots.md)
owns the transport behavior and the
[configuration contract](../../../../docs/spec/daynight-worker-configuration.md)
owns the stored configuration and observation limits.

For the official client, bootstrap and observation are not both non-null; the
9 MiB budget accommodates 4 MiB telemetry plus either 4 MiB configuration or
observation, with bounded inventory and envelope. It does not change those
storage budgets or the transaction rules described by the
[Worker capacity decision](2026-11-07-worker-current-capacity.md).

## Alternatives

**Only split observation items into smaller batches.** A single legal native
item can already exceed 1 MiB, so batching cannot deliver it. Replacing the
actual value with null or truncating it would misrepresent the result.

## Consequences

The server and its ingress must accept the larger body before Workers send it.
An older server or ingress may return 413; that failure cannot acknowledge the
configuration. Only configuration reports receive the larger allowance, and
field, collection, stored telemetry, Worker and accepted observation limits
still apply independently. Large simultaneous values can still be rejected by
the storage checks and roll back the report transaction.
