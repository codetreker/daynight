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
explicit owner, endpoint and tab navigation. A selected detail frame survives
withdrawal of its configuration projection: it presents owner access loss, read
failure or loading and retains an explicit return to the same owner’s list. Read
errors belong to the panel selected by navigation, so a narrow hidden list cannot
be their only presentation. A service/principal-bound catalog
gates reads and writes independently of sidebar Team preferences. The page uses
strict browser DTO decoding and fresh authorization; private configuration stays
in scoped memory, separate from task IndexedDB. Empty subscription
presentation depends on the validated endpoint collection independently of the
project directory. Scoped state-icon track alignment excludes unrelated generic
page styles. Its scope placeholder, numeric badge text and fixed heading
styles retain the prototype geometry without weakening long resource-name
wrapping. Tab labels keep the trailing separator in one text node so glyph
shaping does not depend on an extra inline text fragment. The heading's unstyled action wrapper keeps the native button in an
inline formatting context. Creation forms alone retain the prototype fieldset
intrinsic minimum; editing and subscription forms keep their existing sizing.

One controller per owner fixes the exact request bytes, operation identity,
issued time, actor, versions and SHA-256 at submission. Unknown results reconcile
only through the original receipt GET. Session storage contains minimal prepared
metadata without the body, URL, credentials, secret or payload; reloaded records
support GET recovery only. Confirmed historical effects and the current resource
projection remain distinct. Confirmed submission and receipt reconciliation
refresh the current owner, endpoint and filter through the live route reference.
Creation confirmation selects the new endpoint; a callback captured before its
navigation cannot restart a read for the old selection. Read generations still
exclude late responses, and the original operation remains fixed. Confirmed
receipts reject later contradictory results. Configuration forms preserve explicit field edits independently of the
CAS baseline: review refreshes untouched values, and concurrent dirty-field
changes require a deliberate resolution before a new submission. The shared
receipt rules are owned by the
[receipt decision](../bug-fix/2026-11-08-webhook-receipt-results.md).

Scoped reads bind endpoint and auxiliary publication to both its owner read
generation and confirmed Team membership role/version. A directory-confirmed
downgrade or a newer restrictive endpoint or summary observation invalidates old
administrator projections, including summaries and cached views on return. An
unchanged older directory cannot restore permission; a new membership identity or
version provides fresh authority. Only media/principal-validated server error semantics revoke an owner or
withdraw a missing resource; protocol failures carrying those statuses retain
verified state and recovery. Forbidden configuration or receipt reads revoke the
whole owner; forbidden management or secret requests withdraw administrator
projections while preserving member read admission. Request-owner and
authorization-key fencing prevent old denials from revoking new authority. The
[management-denial decision](../bug-fix/2026-11-08-webhook-management-denial.md)
owns that distinction. Resource absence remains local. Management observation and
readable membership identity are separate: a restrictive Delivery destination
can withdraw old endpoint, secret and administrator projections while continuous
Team membership retains its Project and history read access. ID-only
configuration-checking and missing-configuration history contexts do not
fabricate configuration DTOs. Their established history lifetime uses readable
identity independently of configuration reads: a later configuration 500 displays
separately while preserving authorized history and the last authoritative
context. Original receipts remain independent. These reads preserve mounted
nodes, drafts, focus, selected tabs and loaded pagination through unchanged
background checks. Confirmed identity or disclosure changes
withdraw private values. Explicit or responsive departure from the secret
region removes its plaintext and invalidates late reads, including when the
endpoint cache remains available. Storage cleanup failures remain visible and retryable
without blocking identity quarantine. Native dialogs inherit page language and
keep keyboard isolation, opener restoration and reachable scrolling actions.
The [browser design](../../../../docs/design/webhook-web.md) owns the mechanisms
and its [requirements](../../../../docs/spec/webhook-web.md) own visible behavior.

## Alternatives

**Reuse the CLI wire module in the browser.** Its Node cryptography and Buffer
imports are runtime dependencies unsuitable for the browser bundle. The Web
client instead uses the existing browser request stack and Web Crypto.

**Refresh the route captured by the submitting callback.** Creation confirmation
changes the selected endpoint before the callback finishes. Restarting the old
selection advances the same owner read generation and can cancel the new detail
load. The existing live-route refresh keeps the current view independent of the
fixed original operation.

**Persist full requests for recovery.** This retains sensitive configuration
outside the active page. Minimal identity and hash metadata support safe GET
reconciliation without granting replay from a missing body.

**Replace the shared workspace shell with the prototype shell.** Account, Setup
and sidebar interactions already have production behavior. Preserving the shell
keeps those controls intact while product content and dialogs follow the approved
component styles and local geometry.

**Force display on a direct flex item.** Flex-item blockification changes the
resolved display despite an inline-flex declaration. An unstyled wrapper restores
the intended formatting context while retaining the same native button.

**Apply intrinsic fieldset sizing to every form.** Creation has the matched
prototype layout, while editing and subscription forms have separate established
layouts. A creation-only marker avoids changing those unrelated forms.

**Return to the list when private detail data disappears.** This changes the
visible selection while the address still names an endpoint and hides the
requested detail’s failure. Keeping a stateful detail frame preserves explicit
navigation without retaining withdrawn private values.

## Consequences

Configuration, subscriptions, signing secrets and delivery registration share
one submission and recovery mechanism. The [delivery observation decision](2026-11-08-webhook-web-deliveries.md)
extends it with independent resource disclosure, payload integrity and original
generation validation. Mutation admission distinguishes receipt reads from
writes and checks the frozen validated original target as well as current catalog
permission before generating the operation identity, after readiness and before
dispatching an intent; restrictive changes remain available. Finite receipt retention limits confirmation availability;
absence and cleanup failures cannot establish rollback. Browser permission checks
may suspend admission while keeping the visible draft intact. Visual evidence
compares content and dialog regions and separately checks the shared shell,
including uncropped captures and explicit outer geometry differences.
