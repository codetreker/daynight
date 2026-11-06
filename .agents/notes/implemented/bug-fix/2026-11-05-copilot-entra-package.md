# Agent Note: Pinned Copilot package for Entra authentication

Status: implemented

## Problem

The inspected macOS arm64 Copilot 1.0.83 npm executable extracts JavaScript that
requires `msal-node-runtime.node`, but its payload omits that addon. The native
Entra broker cannot acquire a token on this path, even when the same profile
works with a complete newer runtime. A plain version probe can forward to an
automatic update cache, hiding the version used by a headless launch that
disables updates.

## Decision

Pin `@github/copilot` and its platform packages to 1.0.105 while retaining SDK
1.0.11 and its existing declaration patch. The macOS arm64 npm executable embeds
the MSAL addon and `libmsalruntime_arm64.dylib`. The platform dependency remains
the executable source; both the Worker capability version probe and the Web
runtime disable automatic updates. Other providers keep their own version
arguments.

The [SDK runtime ownership decision](../../archived/architecture/2026-10-28-copilot-web-sdk-runtime.md)
records the rationale for process lifecycle, native profile, session identity,
role instructions, permissions and unknown send outcomes. The package upgrade does
not change those mechanisms. Installation and restart guidance belongs in the
[CLI reference](../../../../packages/daynight/README.md#web-worker-sessions).

## Alternatives

**Use a system executable or automatic update.** A different installation can
provide the missing broker, but makes the effective version depend on machine
state. It also leaves the declared npm dependency broken. A complete fixed npm
package preserves reproducibility.

**Replace native authentication or update the SDK together.** The direct CLI
fails without the SDK when the addon is absent. Replacing credentials or adding
a broker would change native authentication ownership without addressing the
package defect. SDK changes require separate compatibility evidence.

## Consequences

Fresh installations receive a complete pinned runtime. Existing installations
and already running processes retain their own dependency and native process
versions until updated and restarted. Package completeness does not establish a
valid login or organization authorization; native authentication errors must
remain visible. Runtime acceptance must distinguish the inspected platform,
fresh extraction, direct CLI inference, Provider behavior and actual Worker
execution. Other platforms require their own native authentication evidence.
