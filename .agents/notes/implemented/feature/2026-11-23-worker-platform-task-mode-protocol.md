# Agent Note: Negotiate Worker platform task modes

Status: implemented

## Problem

The two-state Worker preference cannot represent a Worker that waits for work
requiring its own platform. Workers and Web clients upgrade independently, so
extending the saved target must preserve supported older reads, reports and
unrelated edits. A projected preference or a successful save cannot establish
that a Worker understands or has applied a stricter selection rule.

## Decision

The server stores `platformTaskMode` as `all`, `prefer` or `only` in the existing
Worker configuration resource. The
[configuration contract](../../../../docs/spec/daynight-worker-configuration.md#平台任务规则能力)
owns negotiation, input, conflicts and application evidence. This replaces the
server's boolean representation from the
[platform preference decision](2026-11-09-worker-platform-task-preference.md);
the existing two-state clients retain their original selection behavior.

An independent capability selects the enum target and application kind. Legacy
readers receive the boolean projection, with `only` projected as true. Legacy
edits preserve a saved `only` when that projection is unchanged, and require an
upgrade to change it. This decision occurs after the existing target revision
check under the Worker row lock, together with support checks from the latest
accepted observation. A real enum application item proves protocol support;
its state and value separately describe actual application. Old and new items
are never synthesized from each other.

The migration converts stored booleans and advances target revisions, retaining
uninitialized Workers, unknown siblings and observations. Deployment drains old
configuration writers first. Bootstrap retains the old boolean input and cannot
enable `only`. Saving an explicit enum can enter `only` only after a real support
report; an existing strict target can always be retained or explicitly exited.

## Alternatives

**Add strict claim admission on the server.** This would change the Task claim
contract and require a new authority or handshake for client application. The
selection policy belongs to the Worker; the server keeps its existing claim and
candidate rules. Downgrading a Worker therefore does not guarantee strict
selection even while its saved target remains `only`.

**Expose the enum directly to all clients.** Existing two-state readers and
writers cannot interpret it, and an unrelated save can erase the strict target.
Capability projection and the locked legacy update guard preserve those uses.

**Infer support or application from the saved target.** A save only records
intent. Requiring a genuine item in the latest accepted report avoids claiming
support after an older Worker has replaced that report, and preserves pending
or failed application as distinct outcomes.

## Consequences

The service can be delivered before the new clients. Supported legacy clients
continue their two-state operation, and new clients can read the complete enum
contract. The target and observed application remain independently versioned;
support evidence is withdrawn by an accepted report without the enum item.

Operators must stop old configuration writers before migration. Revision
overflow fails the migration transaction and retains its ledger state. A legacy
client cannot exit a saved strict target, so that edit needs an enum-capable
client. The protocol does not enforce strict acquisition against an older
Worker binary.
