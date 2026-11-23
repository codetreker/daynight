# Agent Note: Webhook Web Catalog Compatibility

Status: implemented

## Problem

Webhook clients and services can upgrade independently. Requiring all six known
events prevents a Web client from reading a catalog after Steps subscriptions
retire. Locally fixed subscription choices also offer events the service no
longer accepts. Existing subscriptions and delivery history retain their own
known event types and must remain readable.

## Decision

The Web decoder requires one of each continuing event and accepts the optional
`task.step_updated` entry. Every entry retains strict wire type, schema version
and resource kind checks; unknown, duplicate and incomplete catalogs fail.

Ordinary Webhook creation and subscription editing use the authenticated page's
catalog. The Inbox subscription panel loads its catalog with projects and its
original endpoint under the same authenticated admission. Both derive offered
events from that catalog, using presentation order independently of subscription
selection. Existing subscription identities and selected events survive editing;
known event decoding remains independent of the subscribable catalog.

The [Web design](../../../../docs/design/webhook-web.md) and
[Inbox design](../../../../docs/design/assistant-task-inbox.md) own the current
mechanisms. The existing [Webhook management decision](2026-11-08-webhook-web-management.md)
owns fixed write intents and authenticated admission.

## Alternatives

**Require six events until service retirement.** This prevents the compatible Web
bundle from working with the five-event service during independent upgrades.

**Filter existing selections through the offered events.** This can silently
remove an existing binding when saving another event. Offered choices determine
what can be added; loaded configuration remains the edit baseline.

## Consequences

One Web bundle reads both catalog shapes while preserving the original form
layout and order. Invalid catalogs still fail visibly. The catalog does not grant
subscription permission; the service decides configuration eligibility and
versions. Supporting a future event requires an explicit decoder and presentation
update, preserving strict protocol validation.
