# Agent Note: Immutable MCP Attachment Downloads

Status: implemented

## Problem

An attachment can be replaced while a client reads it over several requests.
Combining ranges from different versions silently corrupts the result, while
returning complete arbitrary files by default can overwhelm a model context.
Temporary content also needs a durable owner and revocable access.

## Decision

An explicit open registers the caller's transfer ID and copies one stable
attachment handle into the private transfer namespace. A published receipt
records its length and SHA-256. Subsequent ranges use that immutable object and
revalidate the current credential, stable authority and task access. Repeated
open observes the existing record without making another copy. Cleanup uses the
shared lifecycle and never deletes the source attachment.
Inspect uses the content I/O budget because it opens a file. New opens switch
from the control budget to that budget before waiting for file resources;
failed admission retains the control permit until the error is delivered.
Existing transfer status and cancellation retain control capacity when content
operations are saturated.

Inspection returns metadata by default; bounded explicit reads default to 8 KiB.
Text ranges stop at UTF-8 boundaries and binary data requires explicit base64.
Task admission reads only presence, and metadata is projected with a MIME byte
limit before it is materialized; default results also have an encoded byte
budget. Oversized MIME or paths return an explicit error instead of being
silently truncated. The original attachment is not altered, but MCP does not
provide complete reads for those exceptional metadata values.
The [attachment design](../../../../docs/design/daynight-task-attachments.md#mcp-私有传输内容)
owns the current interface and lifecycle.

## Alternatives

**Read each range from the source path.** A concurrent replacement can mix
versions even if each individual read is authorized and internally consistent.

**Keep an open file handle in memory.** It cannot survive a server restart or
route later requests to another instance, and has no durable capacity owner.

**Add a separate MIME streaming protocol.** It would retrieve exceptionally
large legacy metadata, but requires another durable snapshot and expanded tool
inputs. Bounded MIME values are returned without an additional protocol;
exceptional values receive a clear refusal without changing the stored attachment.

## Consequences

Snapshots require temporary disk capacity and a full initial copy. Rechecking
access prevents retained content from bypassing a revocation. Failed or
interrupted preparation remains owned by the shared cleanup lifecycle; a repeated
ID reports its existing state rather than claiming an unproven receipt.
