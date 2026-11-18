# Agent Note: Worker Repository Root Query

Status: implemented

## Problem

The Worker queried the bare flag and top-level path with two native processes
before it could prove that the configured path identified the worktree root.
Combining repository metadata without preserving field boundaries or the
order of later reads could misclassify a repository or reuse stale ownership
evidence.

## Decision

The [Worker Git manager](../../../../packages/daynight/src/commands/worker/worktrees.ts)
obtains the bare flag and native root from one `rev-parse` before verifying
physical identity. The flag is the only framed record; the rest of stdout is
one path. The path validator continues to reject line breaks instead of
accepting a truncated path. Git prints the bare flag before returning
exit 128 for the absent top-level path of a bare repository. The
[bounded Git reader](../../../../packages/daynight/src/repository/git.ts)
exposes failed stdout privately only when requested and only for an ordinary
completed exit. This preserves the bare diagnostic without depending on
localized stderr; unrelated Git, signal, cancellation and cleanup errors
continue to propagate. The manager still checks origin before independently
reading the absolute common directory and verifying its physical identity.

## Alternatives

**Split all Git paths on newlines.** POSIX permits those bytes within a path.
The fixed flag lets the root remain a single opaque value.

**Read the common directory with the earlier flag.** This would move the
observation from after the origin check to before it. Ownership validation
does not reuse that earlier observation.

**Classify by stderr or an extra lookup after failure.** Non-bare
administrative directories can yield the same error text and status, and a
second command may observe changed Git state.

## Consequences

Valid Worker preflight uses one fewer native process. The root, origin and
common-directory checks retain separate physical and freshness requirements.
Failed output is not added to diagnostic messages or serialized error fields.
