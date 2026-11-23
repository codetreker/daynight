# Agent Note: Independent GitHub App Credential Editing

Status: implemented

## Problem

An administrator may need to replace only one GitHub App credential. A combined configuration form makes that operation harder to identify and mixes unrelated input, although the update API already preserves omitted credentials.

## Decision

The App configuration page provides separate name, private key, and Webhook secret editing actions. Each dialog submits only its selected field with the current App version and verified account identity. Credential inputs are never populated from stored secrets. The existing App operation and admission lifecycle protects each edit, including conflicts and unknown outcomes. The [registration design](../../../../docs/design/github-app-registration.md#管理工作区) describes the interaction and its privacy guarantees.

This refines the [management workspace decision](2026-11-17-github-app-management-workspace.md) without changing its administrator authority or service-side credential proof.

## Alternatives

**Keep the combined configuration form.** It already supports omitted fields, but requires users to find a single credential operation among unrelated inputs and makes accidental cross-field submission harder to rule out.

**Deliver the credential actions separately.** Both actions share one App version and operation guard. Splitting delivery would repeatedly change the same state owner and make isolation between the two drafts harder to establish as one behavior.

## Consequences

Each action makes its target explicit and omits the other configuration fields. Secret replacement still proves the proposed complete credential set on the server, so replacing a Webhook secret uses the stored private key; proving the App identity does not verify Webhook delivery. The separate dialogs must share conflict and unknown-result protection so switching actions cannot bypass an unresolved write.
