# Agent Note: Project Tab URLs

Status: implemented

## Problem

Project sections shared one address even though browser history could traverse
among them. A copied link, reload, new document or authentication return could
not identify the intended Overview, Task list, PR list or Tags section.

## Decision

The project URL identifies the outer section through a single strict `tab`
parameter. Bare project addresses retain the admitted same-document choice or
project preference, defaulting to Overview, and are normalized by replacement.
The URL takes precedence over an incompatible history section; compatible nested
reading remains subject to identity, project and resource admission. Section
links use native browser behavior for modified clicks, while ordinary selection
commits URL and complete reading state together through the existing draft gate.
Only a successful user selection saves the preference. History traversal applies
the destination without replaying actions or saving preferences.

The existing project owner remains mounted across section URLs. Pending task and
chain fragments survive bare-address normalization and retain their existing
resource semantics; explicit section selection removes the pending command. The
[Web requirements](../../../../docs/spec/daynight-web.md) and
[design](../../../../docs/design/daynight-web.md) own the full behavior and
mechanism.

This extends the earlier [reading history decision](2026-11-11-account-reading-history.md):
project section selection is addressable, while nested reading remains in history.
The archived [section restoration decision](../../archived/bug-fix/2026-10-25-project-section-restoration.md)
retains the rationale for per-project preferences on bare entry.

## Alternatives

**Keep all project choices only in history state.** This supported local
Back and Forward without altering sharing semantics, but a copied or reloaded
address could not select a section.

**Encode every nested reading choice in the URL.** This would broaden the
address contract to graphs, details and filters, which already have distinct
resource lifetimes and admission rules. Outer section URLs meet the sharing need
without changing those contracts.

**Deliver routing and its consumers separately.** An intermediate route without
working section links would not provide the requested behavior, while independently
committing location and reading state would break draft admission and history
consistency. The route and its consumers form one delivery unit.

## Consequences

Each outer section has a durable shareable address without serializing drafts or
resource data. URL and history must be committed as one admitted choice, and a
conflicting stored reading cannot restore a different section. Preferences remain
useful for bare entry, while native links and a stable workspace preserve browser
and in-session interactions. Nested selections retain their existing history and resource lifetimes. Ordinary
chain links additionally provide an explicit, one-time entry as described in the
[chain sharing decision](2026-11-18-task-chain-sharing.md).
