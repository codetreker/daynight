# Agent Note: Session message origin

Status: implemented

## Problem

Inputs submitted by Daynight appear in the same native user-message stream as
human inputs. Rendering both as user bubbles incorrectly attributes automatic
notifications to the user. Rebuilding native history can also lose metadata that
exists only in the live submission path.

## Decision

The optional `origin` field on a send payload and its user timeline entry accepts
`user` or `daynight`. Missing origin means `user`. It is presentation metadata
under the existing Session owner authorization, not a separate authenticated
actor. The [Session protocol](../../../../docs/design/task-session-protocol.md#输入消息来源)
owns its wire and persistence behavior.

Submission identity distinguishes Daynight notifications from ordinary input.
The Controller preserves the association between the submitted operation and its
native user message across reconstruction. Codex may rebuild raw item IDs while
retaining the input client ID, so the operation association also owns the durable
timeline entry ID. Both origin attribution and text projection reuse that ID;
image inputs retain the existing publication identity. History and archives carry
the same field. Both display modes render a Daynight notification as an expandable row,
retaining access to its full content and resources.

## Alternatives

**Introduce a separate notification entry type.** Native providers still record
the input as a user message. A second entry type would require reconciling an
additional synthetic timeline entry with that native history. The source field
retains the existing message identity and content model.

**Infer the source from message text.** Human and automatic inputs can contain the
same text. Text matching alone cannot establish provenance or preserve it through
native history reconstruction.

## Consequences

Old inputs and histories retain their existing display. Notification producers
use the normal command path without adding permissions or changing native text.
Consumers must preserve the optional field through parsing and persistence, and
the Controller must keep its operation association durable. This mechanism does
not schedule or deliver events.
