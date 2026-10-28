# Agent Note: Native Controls in the Session Chatbox

Status: implemented

## Problem

A remote chatbox cannot replace the reference session interaction when users
must return to a local client to select models, change permission policies or
invoke discovered commands. A selector without native confirmation can also
misrepresent the model or authority actually used by the agent.

## Decision

Provider-discovered settings and command descriptors travel with the persisted
Session snapshot. Actual values remain separate from pending operation intent.
Controls use the existing authenticated relay, execution fence and durable
operation receipts. A controls revision rejects stale selections at the server
and again at native dispatch; the Controller serializes setting, command and
input dispatch while interruption and interaction responses remain independent.

The chatbox presents settings, slash-command discovery, native working status,
steer and interruption. Provider adapters preserve native defaults, constraints,
confirmation and input lifecycle semantics. Unknown outcomes do not authorize
replaying a mutation. [Session requirements](../../../../docs/spec/task-sessions.md)
and the [protocol design](../../../../docs/design/task-session-protocol.md) own
current behavior and compatibility limits.

## Alternatives

**Only add selectors and send slash text as messages.** This would hide missing
native methods and make rejected or queued settings appear effective. Discovered
commands and confirmed values keep the remote view faithful to the provider.

**Import the reference application's complete session composer.** It couples
replica recovery, resources, windows and session ownership that Daynight does
not share. Reusing interaction patterns with Daynight's own durable operations
preserves its existing authorization and recovery boundaries.

**Use launch arguments whenever a session resumes.** This restores startup
intent but can overwrite settings changed later in the remote view. Native
recovery and verified current values take precedence; unavailable state remains
unknown rather than being reconstructed as an asserted permission grant.

## Consequences

The control plane adds versioned descriptors and operation kinds without new
relay endpoints or database tables. New code reads old sessions without controls;
old strict clients cannot be assumed to accept new snapshots. New features are
available on newly built Controllers, while existing native processes remain
untouched. Image/file input and history editing remain independent extensions.
