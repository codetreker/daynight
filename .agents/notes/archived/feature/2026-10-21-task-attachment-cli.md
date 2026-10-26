# Agent Note: Task Attachment CLI Streams

Status: implemented

## Problem

Task files need terminal upload, discovery, original-content reads and deletion
through the existing server. The project/task client was designed around JSON
responses and complete rendered strings. Decoding arbitrary bytes as text would
corrupt binary files, while buffering an entire file before printing would make
memory scale with file size. A blocked output destination must also leave the
command able to observe cancellation and its deadline.

## Decision

The [attachment requirements](../../../../docs/spec/daynight-task-attachments.md)
and [architecture](../../../../docs/design/daynight-task-attachments.md) own the
cross-component contract. This note owns the CLI implementation. It extends
the text-only callback/output part of the
[project/task CLI design](../architecture/2026-10-20-project-task-cli-design.md)
and implements the existing
[attachment storage decision](../architecture/2026-10-21-task-attachment-storage-design.md);
the storage address, preview trust model and K1 decision remain in that owner.

`task attachment put/list/read/remove` uses the existing server origin,
configuration, project selection and cancellation source. Its nested command
definition drives argument parsing, help and native shell completion. Put's
`--path` is a text option; put/read/remove permit an explicit `--` terminator for
dash-prefixed positional paths. Help remains independent of business loading.

Uploads open one local source and check the opened handle is a regular file;
the same handle supplies the stream and is explicitly closed. The default target
is the source basename. The `mime` 4.1.1 package infers Content-Type from the final
logical target path, with application/octet-stream for unknown extensions.
Attachment paths retain their spelling and are URL-encoded once per segment.
Lists consume all metadata pages using path identity, rejecting duplicate paths
and repeated cursors before emitting output.

The HTTP client selects JSON, bytes or empty-response consumers per operation.
PUT accepts 200/201 metadata, read accepts 200 original bytes and DELETE accepts
204 with an empty body. Existing JSON response/cumulative budgets and lossless
int64 task versions remain intact. Original file uploads and successful content
reads use bounded buffers without those JSON byte caps; request deadlines,
whole-operation deadlines and cancellation still apply. Error responses remain
bounded JSON and preserve operation, target, phase and requestId diagnostics.

`CliContext.stdoutBytes` returns a promise and receives the request cancellation
signal. The real CLI lazily starts a command-owned Node child only on the first
nonempty byte output; `node:child_process` is dynamically imported at that point.
The parent sends at most 64 KiB per frame. The child acknowledges through IPC only
after that frame's stdout write completes, so awaiting the acknowledgement
propagates destination backpressure before reading the next HTTP chunk.

The helper keeps a potentially synchronous fd 1 write outside the parent event
loop. In particular, a blocked Windows stdout pipe must not prevent the parent
from observing cancellation or a deadline. Cancellation, timeout, EPIPE and helper
failure abort the transfer and terminate/reap this owned child. Normal completion
closes input and waits for exit; shutdown waits are bounded and cleanup errors
remain visible. This is a child for one command, without persistent or offline
service behavior.

The server callback now returns string or void. Metadata retains its complete
string result; read writes bytes and returns void. The real context supplies
`closeStdoutBytes`; injected contexts may omit that optional cleanup hook.
`runServerCommand` awaits it before disposing the operation and removing its
signal listeners, on success and failure. Empty reads, help and ordinary metadata
commands do not start the helper.

## Alternatives

**Decode bytes through the JSON/text output pipeline.** Arbitrary attachments
need exact byte preservation. UTF-8 decoding, labels and appended newlines change
content, and JSON size budgets address metadata rather than streamed files.

**Read the whole attachment before writing stdout.** This preserves bytes but
makes memory follow file size and postpones output until download completion.
The selected flow awaits each bounded write instead.

**Write directly to the parent process stdout stream.** Writable callbacks can
express backpressure, but a synchronous blocked fd 1 write can block the parent
event loop before an abort listener or timer gets a chance to run. The helper
moves that write to a separately terminable process while retaining a bounded
request/acknowledgement flow.

## Consequences

Users can manage one task-relative file at a time and pipe original bytes to
other commands or files. Metadata queries retain complete output, original
project selection, text escaping and exact JSON task versions. A failed read can
leave partial stdout; diagnostics stay on stderr and the command fails.

The CLI owns the additional process and must prove its cleanup rather than
assume stream destruction stopped it. Native blocked-pipe, cancellation, timeout
and early-consumer-close tests are required on Linux, macOS and Windows without
platform skips. Test results and installed-package evidence belong to the tested
source, PR and CI run; source availability and local tests do not establish a
successful hosted run on another operating system.

Failed writes are not retried. Storage may already have changed when an HTTP,
PG or local cleanup error is returned. K1 remains recorded only: this CLI adds
no coordinator, compensation, recovery, object identity, history or directory
upload. Browser management and persistent-volume delivery remain separate tasks.
