# Agent Note: Frozen Worker tool runtime admission

Status: implemented

## Problem

A path setting cannot keep version checks, model discovery, Task launches and Bot
recovery on the same installation. Re-reading PATH during recovery can start a
different program while retaining the original Session identity. Copilot's
supported local image authority also runs Node, a Daynight preload and an extracted
distribution: recording only its source SEA would misidentify the actual process.

## Decision

The Worker owns one tool selection manager, with target generations, immutable
launch recipes and explicit probe cleanup owners. Web Task and Bot records freeze
the complete recipe and its observed version before submission. A new spawn checks
that recipe, while operations on a live original process retain its proof. Old
submitted records without identity cannot manufacture a new launch. A never-
submitted original ticket can acquire a create-only, ticket-bound selection
sidecar without changing its bytes or replaying input.

The manager consumes the resolver from the [resolution decision](2026-11-11-worker-tool-path-resolution.md)
and the independently negotiated targets from the [configuration decision](2026-11-11-worker-tool-path-configuration.md).
The [Worker design](../../../../docs/design/daynight-worker.md#本地工具路径选择)
owns storage, admission, telemetry, bounded operations and compatibility details.
The initial runtime delivery kept Herdr automatic until its distinct shell and
instance ownership could consume these recipes; unsupported explicit targets
failed visibly. The [Herdr launch decision](2026-11-12-herdr-frozen-tool-launch.md)
extends admission to controlled mappings and frozen instance recovery.

Copilot authority has an explicit versioned runtime profile. The original source,
Worker Node and preload closure determine a private materialization key. A complete
manifest fingerprints the published distribution. A durable, gated helper owns
extraction, and its original process-group proof survives lost parent IPC after
commit. Incomplete staging never becomes a candidate. The Controller verifies the
trusted Worker root and original frozen files, with no silent native fallback.

## Alternatives

**Keep the SEA as the recorded command and extract per Provider.** This hides the
actual Node and preload dependencies, gives probes different behavior, and changes
the recovered runtime whenever a temporary directory is recreated.

**Disable the existing authority.** This would remove supported image behavior to
simplify tool selection. The profile keeps its existing native permission route
and supported build limits instead.

**Refresh old execution records from the current target.** This can replace the
original program or repeat the first prompt after an uncertain submission. Missing
historical identity remains an explicit recovery boundary.

**Delete published runtimes from active-selection inventory.** An inactive but
recoverable record may still reference them. Reliable per-directory collection
would require a complete reference protocol across SQLite, tickets and sidecars.

## Consequences

Version and path telemetry describe observed recipes and preserve unknown history.
Aliases share canonical cleanup responsibility; target changes cannot abandon
old owners. Candidate preparation reconciles retained cleanup through the original
serial owners within its operation budget before checking admission and capturing
the cache generation. A fresh probe follows confirmed cleanup; unconfirmed cleanup
continues to block spawning. This order lets later requests recover without a
Worker restart while preserving ownership. Provider, version, host and model
queries share the same Copilot process owner, while model queries retain in-memory
SessionFs and reject permissions. The later [background demand decision](../bug-fix/2026-11-13-worker-copilot-background-demand.md)
limits when Copilot candidates are prepared without changing those ownership rules.

Published trees remain with Worker state, including after ordinary shutdown. A
2 GiB budget and durable 512 MiB extraction reservations bound retention and refuse
new materialization when capacity is unavailable. Failed reservations release only
after the original process scope is confirmed stopped and staging is removed.
There is no automatic per-directory garbage collection. Updating or deleting an
original source, Node or adapter can prevent a new spawn of an old recipe; existing
live process control does not require those files to remain present.
