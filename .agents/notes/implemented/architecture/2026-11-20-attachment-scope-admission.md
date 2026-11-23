# Agent Note: Attachment Scope Admission

Status: implemented

## Problem

Attachment listing, file delivery, upload and deletion need explicit credential
permissions while preserving resource visibility, serialized file access and
the existing completion facts. Waiting for a file gate can outlive the policy
authenticated at request ingress. Upload replies also contain an existing
creation timestamp when a file is replaced.

## Decision

An opt-in scoped service binds authorization to one operation while sharing the
original service's file gates and upload capacity. Resource visibility is checked
before scope admission, and admission precedes attachment metadata or file
effects. List requires attachment read permission; deletion requires deletion
permission. Upload requires both upload and read permissions before writing
because its original full response preserves prior metadata.

Open obtains current authorization for the original credential after acquiring
the target gate and before reading metadata or opening the file. The principal
and profile must match, and missing authority fails closed. Fixed profiles retain
their original authorization rules. The reader remains tied to the caller's
context; an admitted stream finishes under the existing lifetime rules without
per-byte permission checks or credential locks held across I/O.

HTTP and ordinary MCP have explicit scoped registrations that reuse existing
parsers and result mapping. Main-site preview GET remains navigation; preview
HEAD uses scoped Open. The independent preview host retains its browser preview
Cookie authentication. Production assembly continues through the original
entry points until scoped credentials are enabled.

## Alternatives

**Checks only in handlers.** Shared service callers could bypass admission, and
an ingress policy could remain stale across target-gate waiting.

**Upload permission alone with the full response.** Replacing an attachment
would disclose its prior creation timestamp. Requiring read permission before
mutation preserves the existing response and completion semantics without
introducing a new upload receipt protocol.

**Rechecking an already opened stream.** Midstream refusal cannot retract bytes
or undo file publication. Admission before opening preserves the established
single-transfer behavior.

## Consequences

Scope refusal cannot read attachment metadata, publish file content or delete
resources. Missing credential refresh support prevents scoped Open. Ordinary
MCP tool discovery and schemas stay unchanged, scope refusals retain the shared
business envelope, and file/transaction uncertainty keeps its original meaning.
Private transfer tickets and chunk publication retain their separate owners.

The [internal contract](../../../../docs/design/credential-scope-internal.md#附件准入)
owns the operation mapping; the [attachment design](../../../../docs/design/daynight-task-attachments.md)
owns file and stream lifetimes.
