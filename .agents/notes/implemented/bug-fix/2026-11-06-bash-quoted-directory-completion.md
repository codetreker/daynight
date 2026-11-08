# Agent Note: Bash Quoted Directory Completion

Status: implemented

## Problem

Bash directory completion inside double quotes can insert filename characters
as shell syntax. With newer Readline behavior, accepting a directory containing
`$` or backticks can expand it or execute a command instead of passing its name.
A previously escaped quote or backslash also needs to remain part of the prefix
used to find candidates.

## Decision

For a double-quoted directory argument, the Bash completion function enumerates
matching directories without reinterpreting the prefix and escapes shell-active
characters in each candidate before returning it. It disables Readline filename
quoting for these candidates and supplies the directory suffix itself. Other
completion contexts retain native filename handling. The
[completion design](../../../../docs/design/daynight-completion.md) describes the
current generator, and the [original completion decision](../../archived/feature/2026-10-20-shell-completion.md)
records its initial design.

## Alternatives

**Rely on Readline filename quoting in every context.** That handling differs
between Bash versions and can insert active shell syntax inside an open double
quote. A generated candidate must remain data when the user accepts it.

## Consequences

Double-quoted directory names retain their bytes across supported Bash versions,
including names with expansion and command-substitution characters. Real PTY
checks exercise insertion and the resulting arguments; directory completion still
uses the local filesystem and does not start a CLI process.
