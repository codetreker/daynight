# Agent Note: Isolate Session image failures

Status: implemented

## Problem

A rejected image capture can interrupt the Session relay and leave a Controller
querying an identity that was never recorded. The same connection also carries
text and state, while a failed capture and an uncertain file or database commit
have different recovery obligations.

## Decision

The [image contract](../../../../docs/design/session-image-contracts.md#定位符采集与读取)
keeps definite capture failures on the original identity and returns eligible
business refusals to the individual request. Missing captures have a distinct
error from missing Sessions. Fence, authorization, malformed frames and uncertain
transaction outcomes retain their existing connection and recovery handling.
Published files and unknown database outcomes retain their original identities
and cleanup ownership.

## Alternatives

**Close the relay on every image error.** This interrupts unrelated text and
state traffic and makes a recoverable image refusal appear as a connection loss.

**Treat every storage error as a failed capture.** A published file may already
be referenced by an unconfirmed database commit; deleting it or starting a new
identity could lose content or duplicate the original operation.

## Consequences

An explicit failed receipt terminates observation of that attempt. Unknown
outcomes still require observation of the original operation, and failed cleanup
remains an outstanding responsibility. The connection staying live does not
guarantee that new content can be stored when storage itself is unavailable.
