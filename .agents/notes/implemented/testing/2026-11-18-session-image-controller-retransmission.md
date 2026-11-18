# Agent Note: Session Image Controller Retransmission

Status: implemented

## Problem

The API integration Controller receives pending image requests repeatedly until
the Server records their responses. A fixture that reads exactly one frame per
stage can mistake a retransmission for the next operation, masking the actual
fixture failure behind an HTTP timeout.

## Decision

The integration Controller validates the request envelope, identity, ordered
operation and payload, and retains each validated response by request ID. It
replays that response only for an identical request on the same Controller
fence; changed requests and unexpected new operations fail. The HTTP flow
cancels its pending request when the Controller fails and drains the fixture.

## Alternatives

**Ignore all unexpected frames.** This would tolerate retransmission but also
hide changed request identities, payloads and ordering errors.

**Increase the HTTP timeout.** The fixture would still reject a legitimate
retransmission and conceal its error until the longer deadline.

## Consequences

The normal integration flow remains strict about new operations while accepting
legitimate repeated frames. The cache exists only for this single exchange and
does not model Controller persistence or recovery across connections.
