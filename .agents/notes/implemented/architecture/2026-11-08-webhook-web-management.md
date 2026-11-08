# Agent Note: Webhook Browser Management and Fixed Intents

Status: implemented

## Problem

Personal and shared Webhooks require explicit ownership and current disclosure
permissions. An interrupted configuration request may already have committed;
reading equal current values cannot prove its original effect, and resubmitting
with a fresh identity can create a second effect. Background authorization checks
also need to preserve unfinished forms without granting unverified admission.

## Decision

The authenticated workspace keeps its shared shell and mounts `/webhooks` with
explicit owner, endpoint and tab navigation. A service/principal-bound catalog
gates reads and writes independently of sidebar Team preferences. The page uses
strict browser DTO decoding and fresh authorization; private configuration stays
in scoped memory, separate from task IndexedDB.

One controller per owner fixes the exact request bytes, operation identity,
issued time, actor, versions and SHA-256 at submission. Unknown results reconcile
only through the original receipt GET. Session storage contains minimal prepared
metadata without the body, URL, credentials, secret or payload; reloaded records
support GET recovery only. Confirmed historical effects and the current resource
projection remain distinct. The shared receipt rules are owned by the
[receipt decision](../bug-fix/2026-11-08-webhook-receipt-results.md).

Scoped reads preserve mounted nodes, drafts, focus, selected tabs and loaded
pagination through background checks. Confirmed identity or disclosure changes
withdraw private values. Storage cleanup failures remain visible and retryable
without blocking identity quarantine. Native dialogs inherit page language and
keep keyboard isolation, opener restoration and reachable scrolling actions.
The [browser design](../../../../docs/design/webhook-web.md) owns the mechanisms
and its [requirements](../../../../docs/spec/webhook-web.md) own visible behavior.

## Alternatives

**Reuse the CLI wire module in the browser.** Its Node cryptography and Buffer
imports are runtime dependencies unsuitable for the browser bundle. The Web
client instead uses the existing browser request stack and Web Crypto.

**Persist full requests for recovery.** This retains sensitive configuration
outside the active page. Minimal identity and hash metadata support safe GET
reconciliation without granting replay from a missing body.

**Replace the shared workspace shell with the prototype shell.** Account, Setup
and sidebar interactions already have production behavior. Preserving the shell
keeps those controls intact while product content and dialogs follow the approved
component styles and local geometry.

## Consequences

Configuration, subscriptions and signing secrets share one submission and
recovery mechanism. Delivery diagnostics can reuse it with their own target and
generation validation. Finite receipt retention limits confirmation availability;
absence and cleanup failures cannot establish rollback. Browser permission checks
may suspend admission while keeping the visible draft intact. Visual evidence
compares content and dialog regions and separately checks the shared shell,
including uncropped captures and explicit outer geometry differences.
