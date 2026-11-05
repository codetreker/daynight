# Agent Note: Browser Team Preference

Status: implemented

## Problem

Returning users need their Team workspace restored without applying another
account's choice or mistaking a transient failure for lost access. Explicit
Project and Task links must retain their resource identities. A saved Team must
also govern the sidebar when a project or global page is the browser's entry;
initial Personal navigation can otherwise send subsequent Team links to the
wrong workspace.

## Decision

The browser stores only the selected Team UUID under an origin-local,
user-specific key. On the authenticated scope's first visible workspace entry,
the preference uses Personal when no selection exists; otherwise it validates
the remembered UUID with an exact Team read. Explicit Team, member and settings
routes select their URL's Team. Standalone Task, attachment and authorization
entries defer restoration until a workspace appears.

A successful installation initializes the current in-memory selection. Ordinary
navigation retains that selection, including an unsaved choice; returning to
`/projects` explicitly restores the saved selection again. A confirmed 404
clears only the matching remembered choice and returns to Personal. Read
failures remain visible and retryable without changing the saved selection; a
failed write leaves the current choice usable and reports that it was not
saved. Shared projects do not represent a Team selection. CLI defaults are
independently owned.

Team-dependent sidebar links and its project directory wait for selection
readiness. The requested page's own resource and the shared-project directory
load independently, and restoration never rewrites an explicit resource URL.
This extends the [Team workspace browsing decision](2026-11-04-team-workspace-browsing.md),
which owns scoped project pagination and creation context.

## Alternatives

**Infer access from the Team picker.** The picker is paginated, so absence from
its loaded pages cannot establish that the account has lost access. An exact
read validates the remembered identity without enumerating all pages.

**Restore only at the default project index.** Explicit resources keep their
identity, but refreshing a project page leaves the sidebar at its initial
Personal selection and sends later member or settings links there. Sidebar
restoration can preserve the requested resource independently.

**Read storage on every ordinary navigation.** Another tab's later selection
would replace this page's current choice, and a pending local save could lose
its owner. Scope initialization distinguishes cold entry from continued use.

## Consequences

The preference is local to one origin and account, and does not grant access or
follow the user across devices. Recovery needs an additional Team read when a
selection exists. Storage and network failures remain visible and retryable;
identity and request lifetime checks keep late results from crossing accounts.
A preserved member or settings view skips revalidation only while its verified
Team is still ready; a cancelled intervening read must restart instead of
leaving the view loading indefinitely. Workspace initialization does not turn
standalone resources into consumers of Team availability or add cross-tab live
synchronization.
