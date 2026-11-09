# Agent Note: Selection Cancellation Reason

Status: implemented

## Problem

A signal received during an interactive selection produced the prompt library's
abort error. Translating that error to a generic cancellation discarded the
command's specific cancellation diagnostic, even though its signal carried the
reason.

## Decision

When the prompt library reports an abort, the terminal selector propagates the
caller signal's reason if that signal was aborted. A prompt exit or closure with
no caller cancellation still becomes a generic CLI cancellation. Worker repository
selection verifies the diagnostic and unchanged configuration through a real
terminal and signal.

## Alternatives

**Always translate prompt errors to generic cancellation.** This loses the
command-specific diagnostic supplied by the operation and makes its cancellation
indistinguishable from an interactive prompt exit.

## Consequences

Callers receive their original signal reason during selection. The selector still
normalizes library-specific exit and internal closure errors when the caller's
signal has not been aborted.
