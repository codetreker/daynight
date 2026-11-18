# Agent Note: Project GitHub Webhook Settings

Status: implemented

## Problem

Project members need to distinguish webhook delivery from successful PR synchronization, and administrators need to configure each repository without exposing its saved secret or disrupting existing connection settings.

## Decision

Project GitHub settings present the optional subscription state and its independent version alongside connection and synchronization facts. Administrators supply or generate a secret and can copy the current draft. Conflict and unknown write outcomes require an admitted read rather than an automatic replay. The [subscription design](../../../../docs/design/github-project-webhook-subscription.md) owns the API and interface behavior.

## Alternatives

**Use a separate settings read.** This adds a request and a separate compatibility path even though the existing status snapshot already provides the subscription when supported.

## Consequences

Older services retain the existing settings without the subscription controls. A valid delivery confirms receipt only; it does not prove a PR was synchronized. A read cannot prove whether an unknown secret write committed.
