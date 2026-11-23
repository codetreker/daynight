# Agent Note: Project Settings Workspace

Status: implemented

## Problem

Execution alerts, personal project prompts, GitHub integration and project
management have different purposes and operation lifetimes. Presenting them in
one long page makes each harder to find, while navigation between them must not
discard drafts, confuse late results with newer interactions or weaken existing
write protection.

## Decision

Project settings use five URL-addressed sections within a stable user and Project
workspace. The shared Project read remains active for the workspace; individual
controllers retain their own drafts, results, admission and retention facts.
Section visibility is distinct from workspace membership, and state summaries do
not participate in the management guard. Accepted operations retain their business
identity while presentation also checks the section generation and original
location. The [requirements](../../../../docs/spec/project-settings.md)
and [design](../../../../docs/design/project-settings.md) own the
observable behavior and implementation boundaries.

The initial four-section delivery retained the independent member page. The
[member integration decision](2026-11-13-project-settings-members.md) brings its
controller into the same workspace while preserving its independent operation
limits. Settings, GitHub, transfer and deletion retain their shared guard;
personal prompts remain independent.

A confirmed deletion withdraws its original admitted cache generation independently of section presentation; the [paused-result decision](../bug-fix/2026-11-11-project-deletion-paused-result.md) retains the admission and cleanup limits.

## Alternatives

**Keep the single long settings page.** It preserves the existing lifecycle but
does not give the distinct settings purposes direct links or a focused reading
position.

**Deliver navigation separately from lifecycle retention.** A visible section
switch without distinct workspace and section activity would clear state, release
or obscure operation protection, or permit a late result to affect a newer
interaction. Navigation and its required retention therefore form one delivery.

## Consequences

Users can link to and revisit a section while retained controllers preserve
in-memory drafts and results. The workspace must coordinate section visibility,
dialog suspension and scroll restoration without replacing the existing business
state machines. Refresh does not persist unsaved drafts or operation results in
the URL. Member and invitation management retain their own lifecycle inside the
workspace; the legacy member route selects that section.
