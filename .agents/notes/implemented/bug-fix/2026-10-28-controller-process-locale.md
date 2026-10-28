# Agent Note: Stable Locale for Controller Process Identity

Status: implemented

## Problem

POSIX process evidence includes the start time printed by `ps lstart`.
macOS localizes that field: a Chinese locale prints a combined month/day
token, which does not match the parser's separate weekday, month and day.
Controller startup consequently fails before recording process ownership.
Comparing evidence collected under different locales can also misidentify
an unchanged process instance and prevent attributable cleanup.

## Decision

Each `ps` identity or group-inventory subprocess receives `LC_ALL=C` in its
own environment. The parent environment and native provider environment
are unchanged. Existing PID, start-time, command-hash and process-group
checks remain mandatory; parsing failures still retain uncertain evidence.
This preserves the ownership rules in the
[Controller decision](../architecture/2026-10-28-controller-test-session-ownership.md)
and the [session design](../../../../docs/design/task-session-protocol.md).

## Alternatives

**Change the user's shell locale.** This would affect unrelated commands
and agent behavior while leaving the CLI dependent on external configuration.
The system query is the boundary that requires normalized output.

**Accept localized date variants in the parser.** Supporting each spelling
and token order adds parser branches and still requires canonicalizing stored
evidence before comparison. A fixed query locale supplies one representation.

## Consequences

Process evidence is stable across caller locale changes without weakening
the ownership check. Real-process tests capture under the C locale, inspect
under Chinese locales and stop the original process group. Installed locale
availability determines whether a non-macOS host exercises localized output;
macOS supplies the concrete combined month/day regression.

Existing failed executions without process evidence remain unconfirmed.
The locale fix does not reconstruct their missing ownership proof or grant
permission to signal an unidentified process group.
