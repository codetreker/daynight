# Agent Note: CLI Team Context

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
depend on a stored default. These reads do not write configuration or remote
resources. Bounded pagination validates the complete collection before output.

`default set` verifies the target and membership without resolving the old
default, then confirms and updates only the current origin/account pair. It
stores the real Personal Team ID for `personal`. The writer compares the
observed service, credential and old pair under the configuration lock and
checks that YAML aliases do not change settings outside that exact path. Network
requests and confirmation do not hold the lock.

The [client requirements](../../../../docs/spec/daynight-project-task.md#team-读取与上下文)
own the observable commands and failures. The
[project scope pagination decision](2026-11-04-project-scope-pagination.md) owns
server filtering and cursor scope; all-accessible Project discovery remains
independent of Team defaults.
The [CLI lifecycle decision](2026-11-04-cli-team-lifecycle.md) owns remote Team
lifecycle writes and their confirmation. The [Project selection decision](2026-11-05-cli-project-team-selection.md)
uses the same target resolution only after repository discovery finds no match.

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
identify a replacement; setting a default can repair it without validating the
old Team. Concurrent credential or pair changes fail rather than overwrite a
newer choice. Pagination retains the server's separate-snapshot semantics.
