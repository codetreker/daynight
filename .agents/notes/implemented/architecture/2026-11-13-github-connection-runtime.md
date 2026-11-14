# Agent Note: GitHub Connection and Runtime

Status: implemented

## Problem

Project administrators need to connect a repository and keep retained PR facts current across restarts and multiple service instances. Remote authorization can change while a connection or synchronization is in flight, and the service must stop work before releasing its dependencies.

## Decision

Verify the configured App's actual installation and repository read access outside the Project transaction, then recheck administrator access, version and stable repository identity in a short write. The service schedules the existing single-Project executor with bounded scanning and concurrency, and owns its cancellation, supervision and drain. Generation and lease checks isolate disconnected, replaced and deleted bindings. The [runtime design](../../../../docs/design/github-connection-runtime.md) owns the operational contract.

## Alternatives

**Use a separate synchronization daemon or a global leader.** PostgreSQL already coordinates individual Project claims; a separate process or leader adds deployment and failover dependencies without improving the required Project isolation.

**Check the operator's GitHub identity or installation ownership.** The configured App's actual repository and PR read capability is the required authorization evidence. An additional user identity check would exclude valid administrators without proving that capability.

## Consequences

Connections and scheduling are available through the same runtime. A Project independently controls whether synchronization is enabled; the [synchronization setting decision](2026-11-14-project-github-sync-setting.md) records that separation and its migration. A crashed or uncertain claim can delay recovery until its five-minute expiry. Different Projects bound to the same repository perform independent reads, preserving their separate permissions and retained data.
