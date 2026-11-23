# Agent Note: Project App Transaction Logging

Status: implemented

## Problem

Project App connection management returns transaction completion to callers, but generic HTTP response logs cannot identify the App, grant and generation involved or establish whether a database write committed. A lost response can follow a confirmed commit; conflating these facts obscures diagnosis and risks an unsafe replay.

## Decision

The Project App service records the original store Completion after each management write scope returns. An observer around the existing transaction DAO captures safe, authorized facts without additional reads or changes to transaction control. Observed versions remain distinct from confirmed committed results. Disconnect records retain the removed binding identity. Unavailable metadata, including impact versions absent from the projection, is omitted.

HTTP logs retain the request ID, actor, canonical Project ID and operation phase through parsing, operation execution and response delivery. Parsed request conditions are explicitly named as requested or expected values. Response failure remains a separate response-phase fact. The [connection design](../../../../docs/design/github-app-project-connection.md) owns the field semantics and privacy boundary.

## Alternatives

**Infer commit from HTTP success or response failure.** Response encoding, cancellation or transport loss can happen after a confirmed commit. HTTP delivery cannot supply the database outcome.

**Read resources again after writing.** A later read can observe another concurrent operation and cannot prove the original transaction outcome. Extra reads also add failure paths and could turn successful writes into apparent failures.

**Log proposed Save values as the result.** A successful callback is compatible with rollback or unknown completion. Proposed values do not establish durable generation or binding.

## Consequences

Operators can correlate connection management with synchronization work while distinguishing committed, not committed and unknown writes from response delivery failures. Logging selects identifiers and typed diagnostic metadata; secrets, resource content and raw dependency errors remain outside the log. This instrumentation preserves the existing authorization, write scope and unknown-result behavior. Controlled completion tests prove the logging boundary; real SQL persistence and transaction mechanics remain owned by store tests.
