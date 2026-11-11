# Agent Note: Controlled Account Change Banner

Status: implemented

## Problem

An account change needs a refresh action in the header that remains operable
when a native modal or fullscreen view isolates the surrounding page. Displaying
multiple live notices would repeat announcements, while moving focus would disturb
ongoing work.

## Decision

The Web `AccountChangeBanner` accepts an active flag and a caller-supplied reload
action. Each instance maintains an empty live region before its active message is
populated. Only the active instance presents a localized polite status with a
keyboard accessible action. Its enclosing header owns placement and responsive wrapping;
the component does not discover identity or change focus or container state.
The [authentication design](../../../../docs/design/daynight-auth.md) describes the
consumer responsibilities.

## Alternatives

**A global overlay or a single page header.** An overlay would disturb the
existing interface, and a page header can be inaccessible behind a native modal
or outside the fullscreen element. An active header supplies the action within
the current interaction scope.

## Consequences

Consumers must select the active header, including modal and fullscreen cases,
and provide a real reload action. The component alone does not detect account
changes or pause remote operations. Controlled browser fixtures exercise the
production component without claiming that the account flow is connected.
