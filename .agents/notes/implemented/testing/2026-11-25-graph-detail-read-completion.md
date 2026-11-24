# Agent Note: Graph detail read completion

Status: implemented

## Problem

The graph detail integration test resolves a controlled Task response before
detail admission has finished its cache and history checks. A dialog-title
assertion can time out while the actual read is still loading, obscuring the
distinction between an incomplete read and a failed one. Independent Project
metadata requests also need controlled responses in this test.

## Decision

The test observes the single real detail-read operation for the selected Task
and waits for it to finish after resolving the response. It retains the loading
assertion and checks the rendered dialog, its enabled controls, Markdown and
attachment behavior. Project metadata and access have explicit fixtures. Test
cleanup releases the wait if the read remains pending when the test ends.

## Alternatives

**Increase the dialog timeout.** A longer fixed delay does not establish that
the read has completed or distinguish a loading state from a read failure.

**Subscribe to detail state.** An extra subscriber changes when the session
releases its read, which can hide cancellation in this integration scenario.

## Consequences

The test observes the actual read without replacing cache admission or adding a
session subscriber. A completed read still requires the UI assertions to prove
success. The observation depends on the session's read operation and must follow
its lifecycle if that implementation changes.
