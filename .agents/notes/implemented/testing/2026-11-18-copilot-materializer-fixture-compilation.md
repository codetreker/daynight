# Agent Note: Copilot Materializer Fixture Compilation

Status: implemented

## Problem

The macOS materializer scenarios compile the same C program for each case.
Its arguments and environment supply the extraction directory, run marker,
and failure choice at execution time. A shutdown case that starts with
persisted extraction records also pays for compilation and executable
fingerprinting before calling close.

## Decision

The [materializer suite](../../../../packages/daynight/test/commands/worker/copilot-tool-materializer.integration.test.ts)
owns one lazily compiled seed. Each case that launches a process copies the
binary to an exclusive path, sets its executable mode, and qualifies its
private launch and support files. Suite teardown waits for the compiler to
settle and removes the seed directory. Per-case teardown owns the copies,
markers, operations, and worker directories.

The historical-owner shutdown case prepares the durable records and opens a
materializer in its private worker directory. Its process observations and
record readback still exercise the close path for both owners.

## Alternatives

**Compile in each case.** Separate compilations isolate executable identity
but repeat the compiler process with identical source.

**Run every case from the seed path.** A shared executable would couple
fingerprinting and alias checks to a file outside each case's ownership.
Independent copies keep each launch path and inode local to its case.

## Consequences

Six compiler launches become one. Five scenarios still qualify private
native binaries. The copied binaries preserve the real extraction, process
ownership, publication, and corruption checks.
