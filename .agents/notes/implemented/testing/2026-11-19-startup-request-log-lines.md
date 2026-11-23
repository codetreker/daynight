# Agent Note: Startup Request Log Lines

Status: implemented

## Problem

Startup fixtures append request logs while tests poll them. A file snapshot can
end in the middle of a record, so parsing every segment can fail before the
fixture finishes writing. The deadline helper also serves plain-text logs.

## Decision

The startup deadline helper passes only newline-terminated, nonblank lines to
its predicate. The JSONL caller parses every complete line before matching the
initialize request, so malformed complete records still fail explicitly.

## Alternatives

**Ignore JSON parsing errors:** This would also hide malformed complete records
and could turn a real fixture error into a timeout.

## Consequences

An unfinished trailing record is considered on a later poll after its newline
arrives. The helper retains its plain-text callers and existing deadline and
cleanup behavior; a permanently unterminated record cannot satisfy the wait.
