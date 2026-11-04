# Agent Note: CLI Team Context Reads

Status: implemented

## Problem

Team-scoped reads need a target for the current account without changing the
identity or discovery of existing Projects. A saved target can become invalid
after access changes, and credentials can identify different users on different
services. A list that prints before all pages are validated can present an
incomplete result as success.

## Decision

The CLI resolves Team reads from an explicit ID or `personal`, then from the
`teamDefaults` entry keyed by normalized service origin and current user ID,
falling back to the real Personal Team only when that entry is absent. It reads
the current principal and validates subsequent response identities and resource
scope. `default show` verifies the target; Team list and explicit targets do not
depend on a stored default. These operations do not write configuration or remote
resources. Bounded pagination validates the complete collection before output.

The [client requirements](../../../../docs/spec/daynight-project-task.md#team-读取与上下文)
own the observable commands and failures. The
[project scope pagination decision](2026-11-04-project-scope-pagination.md) owns
server filtering and cursor scope; all-accessible Project discovery remains
independent of Team defaults.

## Alternatives

**Fall back to Personal when a configured Team is invalid.** This hides lost
access or a configuration error and can make a command act on an unintended
target. A missing entry alone has the Personal meaning.

**Filter all-accessible Project pages in the CLI.** Filtering after pagination
does not provide the server's scoped eligibility or cursor guarantees and can
misrepresent the selected collection. The Team filter uses the server scope.

## Consequences

Accounts and origins keep independent selections, including across token
rotation. A stale selection is visible and explicit reads remain available to
identify a replacement. Member management and saving defaults remain separate
capabilities; the reader retains the established configuration shape without
introducing writes. Pagination retains the server's separate-snapshot semantics.
