# Agent Note: Personal Worker Prompt Editor

Status: implemented

## Problem

A person needs to maintain independent user, Project and Worker instructions
without allowing another account, a concurrent editor or an uncertain network
response to overwrite a draft. Runtime configuration validation and project
administration have different owners and must not prevent a member from editing
personal text.

## Decision

The three entry points use one prompt resource API, edit state machine and
editor. Each draft retains its account, baseline revision and raw text; a save
freezes these facts and its edit generation before admission. Responses are
accepted monotonically, and later input remains separate from the submission.
An uncertain write is reconciled by reading current facts without replaying it
or attributing a matching value to that request. Explicit conflict choices
control whether to replace a draft or continue from the latest version.
Identity pauses cancel the operation's preparation or network wait. Local
settlement distinguishes no dispatch, an unknown dispatched result and a
validated receipt. The original owner retains cancellable publication of a
confirmed receipt behind identity and Project access admission; a later edit
remains separate and a pending publication cannot authorize another save.

Worker prompt and runtime configuration are independent resources. Their
navigation protection is aggregated into one confirmation; retained owners keep
pending and unknown writes across route changes. The later
[peer-tab decision](2026-11-12-worker-detail-prompt-tab.md) places those forms
in separate tabs while preserving this protection. Identity and Project access
checks pause admission and publication without remounting an active editor. Confirmed
identity changes and access withdrawal retire private state. The
[Web design](../../../../docs/design/daynight-web.md#个人-worker-prompt-编辑)
owns the component and request responsibilities.

## Alternatives

**Place prompt in the runtime configuration form.** Runtime validation and
Project-removal confirmation would then block an independent personal resource,
and one form submission could imply a cross-resource atomicity the API lacks.

**Replace drafts on every refresh or retry uncertain writes.** Refresh can
arrive while a person is typing, and a lost response can follow a committed
write. Replacing input loses work; replay can apply a second write.

**Hold the save open until publication is admitted.** An identity pause can
last for the rest of the document lifetime, leaving the original promise and
busy state unresolved even when the network outcome is already known.

## Consequences

All three entry points share concurrency and identity behavior while retaining
independent resource lifetimes. Page owners and explicit conflict choices add
state and navigation coordination. A successful save confirms server state, not
that every Worker has received or applied the value.
