# Agent Note: Assistant task CLI and durable claim credentials

Status: implemented

## Problem

Assistants need to collaborate through the user-owned task API without exposing
claim tokens or losing the identity of a possibly committed operation. A process
can stop after the service commits and before it records the response. A transfer
also changes who may work before the new holder has received a usable credential.

## Decision

The [CLI design](../../../../docs/design/assistant-task-cli.md) implements explicit
commands for the service's complete capability set. Bot identity remains separate
from user authentication. Exact observed versions and generations reach the API
unchanged, and strict response parsing verifies the resource and actor scope.

The CLI persists complete claim intent and a locally generated token before
submission. It reuses the existing private operation file implementation for
atomic synchronized replacement and task-level locking, with service, owner, Bot
and task isolation. The same exported storage and claim coordinator are usable by
the bot host. A pending operation blocks replacement while it could still grant
a usable credential. Proven non-submission has its own durable terminal state
and releases the pending gate without discarding the original intent. Recovery reads the original receipt and current claim;
it never automatically repeats a mutation. Binding requires confirmed renewal
before protected application writes.

The standalone manual and installed skill share one assistant-task reference.
Worker scheduling remains with its existing owner; invoking a CLI command does
not imply a running renewal loop.

## Alternatives

**Return a server-generated token on claim.** The original collaboration proposal
used this mechanism. The [claim contract decision](../architecture/2026-11-12-assistant-task-claim-contract.md)
replaced it because a lost response could strand the only token. The CLI follows
the revised client-generated credential contract.

**Build a separate filesystem lock and persistence mechanism.** The repository
already has private, synchronized operation storage for Session recovery,
including Windows ACL and native lock behavior. Reusing that implementation
avoids divergent secrecy and crash-recovery guarantees.

**Automatically retry an unknown write.** Even an idempotency key cannot establish
that a historical claim remains current. Explicit read-only reconciliation keeps
receipt identity and present execution authority distinct.

## Consequences

Restart recovery retains the original token and intent, while output exposes
only public receipts. Shared storage provides a coordination point for the CLI
and Worker host. Retained operation records consume disk until their owner cleans
up private state. Losing that state cannot be repaired from server hashes.

Version-based endpoints without operation receipts retain client operation IDs
only for diagnostics; they gain no new service idempotency. Cross-Worker delivery,
automatic renewals and application scheduling require their separate host
implementation and acceptance.
