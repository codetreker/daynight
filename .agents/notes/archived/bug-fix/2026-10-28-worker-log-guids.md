# Agent Note: Worker Log GUID Abbreviations

Status: implemented

## Problem

Worker terminal logs repeat full GUIDs in their context, messages and error
chains. These identifiers occupy much of each line and obscure the operation
being reported, while exact correlation still requires complete identifiers.

## Decision

The central terminal renderer abbreviates every full hyphenated GUID in context,
messages and error chains after credential redaction. It keeps the first
8-character hexadecimal component with its original case. Non-GUID text remains
unchanged. JSONL retains complete IDs in its fields, messages and errors for
precise lookup. Event producers, API values, prompts and persistence continue
using complete IDs.

The [worker design](../../../../docs/design/daynight-worker.md#观测关联和错误)
owns the diagnostic rendering and correlation behavior.

## Alternatives

**Keep complete GUIDs in terminal logs.** This supports exact copying from every
line, but repeated identifiers crowd out the reported operation. Complete JSONL
records preserve the information needed for precise lookup.

## Consequences

Terminal lines leave more room for their messages. The first GUID component is
a display abbreviation and may collide; exact identification uses JSONL.
Credential redaction precedes abbreviation so shortening cannot expose part of
a secret.
