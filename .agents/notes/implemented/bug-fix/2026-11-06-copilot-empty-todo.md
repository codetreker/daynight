# Agent Note: Copilot Empty Todo Projection

Status: implemented

## Problem

A new Copilot session can have no user input or native todos, yet its initial
SQL todo read created a synthetic empty timeline entry. Readers then saw an
empty task list instead of a genuinely empty conversation. Suppressing every
empty todo result would leave stale lists after native todos are removed,
including when an existing session resumes.

## Decision

The Copilot provider retains one flag describing whether its stable todo entry
has been projected or may already exist in resumed history. New sessions start
without that flag and omit empty native row sets until a todo entry is emitted.
After emission, empty results continue to update the same entry. Resume starts
with the flag set because an empty current SQL result cannot prove that the
recorded timeline lacks an earlier list.

The flag changes only after successful projection. Failed reads preserve it;
nonempty malformed rows retain their existing diagnostic and projection
behavior. The existing serialized read chain, identity, revision ownership,
shutdown checks and display selector are unchanged. The
[Session design](../../../../docs/design/task-session-protocol.md#copilot-sdk-与私有-runtime)
owns the current mechanism.

## Alternatives

**Discard every empty result.** This removes the initial placeholder but also
loses clearing updates after nonempty lists and during resume.

**Hide empty todos in the browser.** This changes shared display classification
and leaves the synthetic source history in place. The defect originates in
Copilot's first projection, where new and resumed sessions are distinguishable.

## Consequences

New sessions without native todos retain an empty timeline. Clearing remains
observable under the original stable identity. Resumed sessions conservatively
emit the current empty list even if their prior history never contained todos;
avoiding that would require evidence from retained projection history, which
the provider's current inputs do not carry. Native todo read failures and
unmappable rows remain visible through their existing diagnostics.
