# Agent Note: Account-owned Worker Prompts

Status: implemented

## Problem

Workers need user-specific instructions at user, project and Worker scope, while project members must not overwrite one another's text. Concurrent editing, access revocation and large independent project texts require explicit identity, version and bounded transfer semantics.

## Decision

The server stores three independently revisioned personal resources under the authenticated user and exact scope key. Editors use identity-bound CAS; clearing preserves the row and its revision. The [contract](../../../../docs/spec/worker-prompts.md) owns the API and errors, and the [design](../../../../docs/design/worker-prompts.md) owns storage and transaction boundaries.

A bounded selector batch shares the existing configuration report and acknowledgment. Only a confirmed native report is followed by a separate read snapshot; unchanged, unavailable and transient errors remain distinct from an empty value. Prompt data does not become native desired configuration or a task claim.

The Worker retains the received values only in memory and appends the latest available user, project and Worker text to newly assembled inputs. The existing reporter owns bounded catch-up; generation checks reject stale project results. Unknown or oversized input waits without consuming recovery budget, and each native path validates its complete input before submission. Existing delivery evidence continues to own already assembled text.

## Alternatives

**Shared project settings or per-Worker project copies.** Shared settings would expose one member's instructions to others; copies would make one user's Workers disagree about the same project.

**Aggregate every project into configuration.** Independent legal texts could exceed a single response and make synchronization fail as the project set grows. Exact bounded selectors preserve complete values without imposing a project quota.

**Poll separate editing resources.** Independent requests would not use the existing configuration exchange and would add another synchronization schedule. The report header preserves the existing request body budget.

## Consequences

Authorization and revision checks protect different facts: project authorization is held through writes, while conditional writes prevent stale text from winning. A later revocation stops subsequent reads, but cannot retract a completed snapshot. A successful native report remains committed when the following prompt read fails. Server delivery alone does not establish that a Worker has received the text; native input limits can also defer its use.
