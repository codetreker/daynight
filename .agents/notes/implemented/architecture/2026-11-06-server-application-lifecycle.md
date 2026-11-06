# Agent Note: Server Application Lifecycle

Status: implemented

## Problem

HTTP handlers, hijacked connections and detached Session operations can outlive
transport shutdown. Closing files or the database as soon as the HTTP grace
period expires can interrupt work that still owns transactions, locks, drafts or
completion hooks. Resource creation inside the HTTP layer also obscures the
single owner of shared modules and partial-startup cleanup.

## Decision

The neutral configuration package validates inputs before resources are opened.
The application assembly creates one identity client, file root, persistence
resource and shared modules. The HTTP runtime owns listener and request admission;
the application owns the Session engine and underlying resources. The
[MCP entry](2026-11-06-mcp-http-entry.md) stops and drains before the shared relay. Their shutdown
closes admission before waiting for admitted users. Session Operations finish
transaction and publication work before the engine reports idle. See the
[server design](../../../../docs/design/daynight-server.md) for the shutdown
sequence and timeout behavior.

## Alternatives

**Close dependencies when the HTTP grace period expires.** A cancelled handler
or hijacked connection may still be releasing locks or doing file work; closing
its dependencies would convert a bounded wait into an unsafe use-after-close.

**Reuse the expired grace context for resource cleanup.** It cannot wait for
work responding to cancellation and would report a cleanup timeout immediately.

## Consequences

Grace timeout remains an error even if cleanup later succeeds. A cleanup timeout
leaves ownership with the application and permits another close attempt, without
reopening admission. The bounded process exit can still fail while work remains;
callers using the library may wait again before releasing resources. The
[Session boundary decision](2026-11-05-server-session-boundaries.md) records
Operation completion and shared engine semantics.
