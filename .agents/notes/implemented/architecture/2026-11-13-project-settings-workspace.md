# Agent Note: Project Settings Workspace

Status: implemented

## Problem

Execution alerts, personal project prompts, GitHub integration and project
management have different purposes and operation lifetimes. Presenting them in
one long page makes each harder to find, while navigation between them must not
discard drafts, confuse late results with newer interactions or weaken existing
write protection.

## Decision

Project settings use four URL-addressed sections within a stable user and Project
workspace. The shared Project read remains active for the workspace; individual
controllers retain their own drafts, results, admission and retention facts.
Section visibility is distinct from workspace membership, and state summaries do
not participate in the management guard. Accepted operations retain their business
identity while presentation also checks the section generation and original
location. The [Web requirements](../../../../docs/spec/daynight-web.md#项目设置工作空间)
and [design](../../../../docs/design/daynight-web.md#项目设置工作空间) own the
observable behavior and implementation boundaries.

Members and invitations remain on their existing independent page. The settings,
GitHub, transfer and deletion operations retain their shared guard; personal
prompts remain independent.

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
the URL. Member and invitation management continue to use their separate route
and lifecycle.
