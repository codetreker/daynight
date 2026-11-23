# Agent Note: GitHub PR Detail Reader

Status: implemented

## Problem

Project members need to read retained pull request details without confusing GitHub PR numbers with Task identities. Background checks must not discard the reader's position or expose another account's data.

## Decision

The Web detail reader owns a Project and PR number scoped request session and a separately mountable dialog. It checks the response principal and requested number, isolates user and Project changes, cancels withdrawn reads, and admits results by request generation and exact revision. The dialog keeps its reading state through ordinary refreshes. The [read design](../../../../docs/design/github-pr-reading.md#web-详情组件) describes presentation and caller responsibilities.

## Alternatives

**Reuse Task details.** Task details require UUID identity and their Markdown extensions have different resource and execution behavior; using them for PR numbers would conflate distinct resources and permissions.

**Replace the dialog on each refresh.** Reopening loses focus, scroll and the raw Markdown choice during background reconciliation.

## Consequences

The component can be mounted by a Project PR list without another identity admission layer. The caller supplies access state and schedules reconciliation; this capability alone adds no Project navigation. Basic Markdown omits remote images and executable extensions, so some GitHub formatting is deliberately unavailable.
