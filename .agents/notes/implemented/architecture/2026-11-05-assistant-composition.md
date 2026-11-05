# Agent Note: Compose assistant hosting and navigation

Status: implemented

## Problem

Bot management, native execution and browser conversations have separate owners.
Publishing a hosting report before the Worker runs those owners would make a
name-only creation choose a machine that never starts its assistant. Conversely,
a completed management page without navigation is not a usable product entry.
The composition must also preserve task capacity, cloud configuration updates,
and the Worker's responsibility for stopping every owned execution.

## Decision

The foreground Worker composes the existing Bot inventory, process, Session API
and deletion manager beside the Task coordinator. Bot discovery does not wait
for repository preparation or consume task slots. Current effective native
configuration supplies hosting observations and new execution defaults; existing
Bot configuration and role text remain frozen. Shutdown joins management work and
all execution stop attempts before stores close and the instance lock releases.

The authenticated sidebar exposes `/bots` and `/bots/{botId}`. The server serves
the application shell at both paths for direct navigation and reload, and reserves
the `/bots` namespace against custom authentication endpoints. The management
page retains its shared Session View, bounded pane cache, identity fences and
deletion coordinator. Server construction continues to inject the same persistent
store, file storage and Session relay into public and Worker Bot routes.

Installed-CLI acceptance exercises public Bot/Worker operations against the real
server. Production-page browser acceptance exercises the public routes and shared
relay. Controlled Worker observations and native transports remain labeled as
such; they cannot establish live Provider authentication or whole-product
acceptance. No mock product pages are part of the application.

The [assistant design](../../../../docs/design/assistant.md) owns composition;
the [Worker execution decision](2026-11-05-worker-bot-runtime.md),
[management page decision](2026-11-05-bot-management-web.md), and
[browser deletion decision](2026-11-05-bot-browser-deletion.md) retain their
mechanisms and rationale.

## Alternatives

**Recreate the Bot runtime for every cloud configuration update.** This would
stop existing conversations when only future defaults changed. Reading current
configuration at the owning boundaries preserves ongoing execution and frozen
intent while updating new observations.

**Enable navigation and advertisements independently of runtime composition.**
The page would accept definitions that no real Worker services. Connecting the
existing owners before publishing support preserves the meaning of automatic
default selection; older Workers remain explicitly unsupported.

## Consequences

Assistants share the existing foreground Worker and normal CLI authorization.
Closing browser views does not stop them, but an offline machine cannot execute.
Task, Herdr and standalone Test paths retain their own lifecycle; no automatic
Test conversion or revival of discontinued Conversations occurs.

Deletion covers Daynight-managed conversation and private execution data, leaving
ordinary directories, independent tasks/worktrees and Provider-owned history
intact. High availability, automatic migration, OS service installation and
Webhook/MCP adapters remain outside this feature. Later transports can reuse the
same browser-independent Bot identity and CLI business operations without
changing task permissions or introducing a second scheduling system.
