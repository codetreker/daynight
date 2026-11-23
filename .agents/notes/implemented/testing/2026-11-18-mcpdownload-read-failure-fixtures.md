# Agent Note: MCP Download Read Failure Fixtures

Status: implemented

## Problem

The download failure tests copied an attachment through PostgreSQL to prepare
a private snapshot or loaded a database to observe repeated missing sources.
Their assertions concern file failures and pre-copy slot allocation.

## Decision

The chunk failure test uses a real private file at the scoped object address.
Controlled Store records provide the immutable receipt and explicit permit
outcomes. The real download path exercises authorization, file gating and
range reading. An open, size, read or short-range failure returns no content.

The missing source test runs the real precheck against independently
specified missing rows. It rejects any attempt to allocate, reserve or
write a transfer. Existing PostgreSQL and file tests retain the proof of
real successful copies, slot counts and contention.

## Alternatives

**Copy a snapshot through the complete Store fixture.** This supplies real
bytes and metadata but repeats allocation and persistence before each
range error case.

**Substitute the file read operation.** This would erase the actual permit,
gate and range behavior under test.

## Consequences

The targeted failures run without PostgreSQL. Actual file and Store
lifecycle witnesses continue under their isolated resources.
