# Agent Note: Worker Log Presentation

Status: implemented

## Problem

Every newly claimed task starts with a NULL native session ID. Logging that
state as a warning makes a normal first launch appear to require attention. The
same launch path also handles recovery when no native session ID was saved.

Worker terminal logs repeat full GUIDs in their context, messages and error
chains. These identifiers occupy much of each line and obscure the operation
being reported, while exact correlation still requires complete identifiers.

## Decision

The worker emits `kind: "info"` with the message `Starting a new native
conversation in the task worktree.` before starting a NULL-ID conversation.
Known IDs still select resume, and live agents still reconnect without starting
another conversation. This supersedes only the warning classification in the
[claim-records decision](../simplification/2026-10-27-worker-claim-records.md).
Its NULL-ID startup behavior and persistence limits remain in force.

The central terminal renderer abbreviates every full hyphenated GUID in context,
messages and error chains after credential redaction. It keeps the first
8-character hexadecimal component with its original case. Non-GUID text remains
unchanged. JSONL retains complete IDs in its fields, messages and errors for
precise lookup. Event producers, API values, prompts and persistence continue
using complete IDs.

## Alternatives

**Keep Warning for a NULL ID.** This exposes a possible loss of continuity during
recovery, but it also warns on every ordinary first launch. A NULL ID alone does
not establish that a previous conversation existed or that anything failed.

**Keep complete GUIDs in terminal logs.** This supports exact copying from every
line, but repeated identifiers crowd out the reported operation. Complete JSONL
records preserve the information needed for precise lookup.

## Consequences

Normal fresh launches remain visible without creating false warnings, and
terminal lines leave more room for their messages. The first GUID component is
a display abbreviation and may collide; exact identification uses JSONL.
Credential redaction precedes abbreviation so shortening cannot expose part of
a secret. Recovery with a NULL ID can still lose continuity with an earlier
conversation. Known-ID resume failures and conflicting observed IDs remain
visible errors.
