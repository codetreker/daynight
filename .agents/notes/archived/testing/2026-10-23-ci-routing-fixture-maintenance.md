# Agent Note: CI Routing Fixture Maintenance

Status: implemented

## Problem

The module-routing tests create short-lived Git repositories. The complete
change-list case commits more than 3,100 paths, and one main CI run failed while
its cleanup hook removed the repository with `ENOTEMPTY`. The assertions had
passed, and the same test passed in the preceding run. The log does not identify
which process left the directory nonempty.

Git commits can start automatic repository maintenance, and Git may detach that
work into the background. The fixture exceeds Git's documented loose-object
maintenance threshold. See the [commit maintenance call](https://github.com/git/git/blob/7e34d8174dcda3435d1404c9a30bef46afe6c13e/builtin/commit.c#L1963-L1967),
the [automatic-maintenance defaults](https://github.com/git/git/blob/7e34d8174dcda3435d1404c9a30bef46afe6c13e/Documentation/config/maintenance.adoc#L1-L15),
and the [loose-object threshold](https://github.com/git/git/blob/7e34d8174dcda3435d1404c9a30bef46afe6c13e/Documentation/config/maintenance.adoc#L73-L80).
Those facts make detached Git maintenance a plausible writer; the CI log does
not prove it was the specific process involved.

## Decision

Each synthetic routing repository sets `maintenance.auto` to false before
creating commits. The fixture tests path selection and does not need Git's
automatic housekeeping. Cleanup remains fail-fast so another writer still
surfaces as a test failure.

## Alternatives

**Retry recursive removal.** Retrying could hide a background writer and would
not prevent fixture files from changing during teardown.

**Leave automatic maintenance enabled.** This preserves repository defaults
inside a temporary fixture, but commits can leave background Git work writing
under a directory as its test hook removes it.

## Consequences

Temporary routing repositories cannot start Git's automatic maintenance. The
large changed-path test continues to exercise the complete Git diff. CI cleanup
still reports `ENOTEMPTY` if another process writes into the fixture directory.
