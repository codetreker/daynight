# Agent Note: Combine ordinary row Session warning and attention copy

Status: implemented

## Problem

An ordinary Task row can show both a Session check warning and an attention
flag for the same observation. Presenting both as separate phrases repeats the
request for attention and makes the row harder to scan.

## Decision

The original fix combined `warning` and `needsAttention=true` into one Session
attention description for plain text and the accessible Session action. It kept
a warning without attention as a check prompt and treated notice plus attention
as separate facts. The later
[unified status decision](../simplification/2026-11-20-unified-task-row-status.md)
replaces that wording policy: the native projection derives notice and attention
from the same state, so notice always selects one response phrase. Warning still
selects attention when flagged and a check prompt otherwise, without a Session
prefix. The [Session status design](../../../../docs/design/task-session-status.md)
owns the current presentation and admission conditions.

## Alternatives

**Alter the observation.** Removing the attention flag or changing warning at
its source would affect other consumers and erase independent state semantics.
The duplicate wording arises only in ordinary row presentation.

## Consequences

Project and personal ordinary rows share the concise description while retaining
their existing warning and attention attributes, visual role, entry eligibility
and startup grace. Chain and Goal summaries, graph and detail presentations keep
their own rules. The [shared-row decision](../architecture/2026-11-15-personal-shared-task-row.md)
and [startup grace decision](2026-11-14-personal-session-startup-grace.md) retain
their original responsibilities.
