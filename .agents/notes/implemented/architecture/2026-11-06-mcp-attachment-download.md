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

Inspection returns complete metadata by default; requested content reads default
to 8 KiB. Text ranges stop at UTF-8 boundaries and binary data requires explicit
base64. Task authorization reads only presence. Stored metadata is read through
the ordinary opener without MIME or encoded-result admission; input path and
range rules remain I/O responsibilities. The
[ordinary resource-page decision](../simplification/2026-11-09-canonical-resource-pages.md)
removes the earlier metadata projection and result-byte guards. At the original
decision, exceptionally long stored MIME or paths received a refusal without
changing the attachment; that historical read requirement is superseded.
The [attachment design](../../../../docs/design/daynight-task-attachments.md#mcp-私有传输内容)
owns the current interface and lifecycle.

## Alternatives

**Read each range from the source path.** A concurrent replacement can mix
versions even if each individual read is authorized and internally consistent.

**Keep an open file handle in memory.** It cannot survive a server restart or
route later requests to another instance, and has no durable capacity owner.

**Add a separate MIME streaming protocol at the original decision.** This
would have retrieved exceptionally large historical metadata but required another
durable snapshot and expanded tool inputs. The original read guard returned
bounded MIME and refused exceptional values without changing the attachment.
Ordinary metadata reads now make that separate protocol unnecessary.

## Consequences

Snapshots require temporary disk capacity and a full initial copy. Rechecking
access prevents retained content from bypassing a revocation. Failed or
interrupted preparation remains owned by the shared cleanup lifecycle; a repeated
ID reports its existing state rather than claiming an unproven receipt.
