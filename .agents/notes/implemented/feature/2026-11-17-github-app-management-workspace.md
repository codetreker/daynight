# Agent Note: GitHub App Management Workspace

Status: implemented

## Problem

Independent GitHub Apps have their own administrators and credentials. Team and Project views cannot offer their management operations without conflating these roles or exposing private consumer data.

## Decision

The global App workspace provides registration, configuration, and removal to the current App administrator. It retains in-flight work across navigation and clears sensitive drafts on loss of authority or account change. The [registration design](../../../../docs/design/github-app-registration.md) describes the user-facing and privacy contracts. The [independent credential editing decision](2026-11-17-github-app-independent-credential-editing.md) refines the configuration interaction while retaining this workspace and its authority model.

## Alternatives

**Manage Apps in Team settings.** This would imply Team ownership of an independent resource and incorrectly mix Team membership with App administration.

## Consequences

Administrators can configure an App without receiving additional Team or Project access. Removal previews expose only authorized project details and aggregate the remainder. The registration API proves credentials, not Webhook delivery; unknown writes remain unresolved until the operator inspects current state and decides what to do.
