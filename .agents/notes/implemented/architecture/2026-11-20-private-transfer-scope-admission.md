# Agent Note: Private Transfer Scope Admission

Status: implemented

## Problem

Private transfers outlive a request and bind an OAuth family rather than one
access token. A policy snapshot captured at authentication can become stale
before a chunk, snapshot receipt or target publication is admitted.

## Decision

The optional scoped transfer service reads current policy under the existing PAT
or grant then access locks in each admission transaction. Download publication
and post-read renewal check read permission before exposing bytes or a receipt;
upload chunk and final attachment publication check upload permission. Full
attachment metadata also requires read permission. The final publication checks
the original credential inside the attachment mutation transaction. Internal
completion and cleanup retain their original admission so that an already
accepted operation can settle. The [attachment design](../../../../docs/design/daynight-task-attachments.md#mcp-私有传输内容)
describes the lifecycle; the existing [private transfer decision](2026-11-06-private-transfer-lifecycle.md)
owns its stable binding and capacity guarantees.

## Alternatives

**Store scope in the transfer record.** A persisted snapshot would authorize
later operations after a credential policy edit and duplicate the grant policy.

**Check only before file I/O.** A policy edit during a download read or before
the final upload transaction could otherwise permit a later delivery or write.

## Consequences

Credential edits serialize with each bounded admission transaction; the same
OAuth grant can continue with a valid new access token. File and database
effects retain their existing non-atomic failure semantics. The scoped entry
is explicit and the existing product assembly remains unchanged.
