# Agent Note: Assistant Task Inbox

Status: implemented

## Problem

Assistant tasks can hold a long-running responsibility, but an assistant only
learns about Project activity by polling or by being told in chat. External
systems have no way to notify an assistant, and Daynight's own outbound
Webhooks can only reach public HTTPS receivers, while assistants run on Worker
machines that are usually unreachable from the internet.

## Decision

Each assistant task has an optional inbox with a public URL on the Daynight
server, as specified in
[the inbox specification](../../../../docs/spec/assistant-task-inbox.md) and
[its design](../../../../docs/design/assistant-task-inbox.md). Requests to
`POST /api/v1/assistant-task-inbox/{inboxId}` become `inbound` assistant task
events for the current holder Bot and travel through the existing Worker event
delivery, which renders them as compact `origin=daynight` notifications and
fences external content as untrusted data.

A Project event subscription is an ordinary personal outbound Webhook endpoint
whose URL is the token-free inbox URL. Daynight events are authenticated by
comparing the request bytes with the captured event fact on the server and
confirming that one of the owner's personal endpoints delivered it to this
inbox; external senders use a bearer token that only the owner can enable,
rotate or disable. Receipts make repeated deliveries of one event idempotent.

Captured Webhook events store their authenticated actor server-side
(migration `097_webhook_event_actor.sql`), and Task, Step and Thread writes
accept an optional `X-Daynight-Bot-Id`, which the CLI sends when
`DAYNIGHT_BOT_ID` is set. The inbox suppresses events caused by its holder Bot
and events caused by another of the owner's Bots shortly after that Bot was
notified about the same Task. Inbox storage is migration
`099_assistant_task_inboxes.sql`.

The Web subscription panel only creates or edits the user's own subscription
for the inbox. Concurrency and policy correctness stay with the Webhook
service: the panel submits the observed `ifVersion`, shows `version_conflict`
with a Reload action, displays server error codes as returned, and links to the
Webhook page for endpoint lifecycle. The inbox management panel follows the
same rule for enable, disable and rotate.

## Alternatives

**Bot-level inbox.** An inbox owned by a Bot has no claim, transfer, pause or
deletion semantics, and its subscriptions would need new rules when a Bot is
deleted or replaced. Tying the inbox to an assistant task reuses those rules
and routes events to whichever Bot currently holds the responsibility.

**Internal `assistant_task` Webhook destination kind.** Delivering subscribed
events by writing directly into the task, without an HTTP round trip, avoids
the public hop, duplicate payload storage and the localhost restriction. It
couples the Webhook delivery runner to assistant task storage and requires a
second destination adapter before any user value exists. The HTTP form needs
no change to the outbound module and also serves external senders; the
internal shortcut remains a later optimization when the server recognizes its
own inbox URL.

**Token in the subscription endpoint URL.** Daynight endpoints can only carry
a URL, so a token would sit in the query string. Rotating it changes the
endpoint destination, which advances the destination revision and ends both
automatic retries and manual redelivery of earlier Deliveries; the token would
also appear in endpoint configuration and delivery history. Verifying Daynight
requests against the captured fact and the owner's Delivery needs no secret,
so rotation never touches subscriptions.

**Sharing the endpoint signing secret with the inbox.** Verifying the Standard
Webhooks signature would require users to copy and rotate a secret in two
places. The stored fact and Delivery already prove origin.

**Server pushing directly into the Bot Session.** The assistant task
specification states that the server does not send Session messages on behalf
of the Worker, and the Worker path already guarantees idle-only delivery,
operation recovery and acknowledgement. A server push would duplicate those
guarantees.

**Actor in the outbound wire format.** Adding the actor to `data` changes the
published data schema, and CloudEvents extension attributes are rejected by the
published envelope schema, which forbids additional properties. Either form
would also disclose user and Bot IDs to every receiver. The inbox already reads
the captured event by ID, so storing the actor server-side gives it the fact
without any wire change.

**Relying on the assistant to ignore its own events.** Prompt-level discipline
cannot bound a feedback loop when the assistant replies to a Thread event with
a Thread post. Server-side suppression plus rate and backlog limits bound it
mechanically.

**Suppressing only the holder Bot.** Two assistants of the same user that
subscribe to the same Project would wake each other indefinitely, because each
hop is caused by a different holder.

**Suppressing every Bot of the owner.** This stops cross-assistant loops but
also hides genuine Project work done by the user's other assistants, which is
a primary thing a monitoring assistant needs to see. Suppressing another Bot's
event only when that Bot was notified about the same Task within ten minutes
targets the reaction that forms a loop and keeps independent work visible.

**Client-side concurrency and policy handling in the panels.** Earlier panel
revisions tracked draft base versions, pre-read endpoints before creation,
adopted just-created endpoints, mirrored the outbound address policy and the
maintenance-mode gate, and coordinated token, receipt and refresh ordering
after lost responses. Each added state produced new multi-tab and ordering
races and duplicated server rules that could drift. The server already owns
optimistic locking, operation receipts, inbox idempotency, eligibility and
address policy, so the panels only use those contracts and show their errors.

## Consequences

- Assistants receive Project events and external notifications without a
  reachable Worker address, and a replaced holder Bot receives pending
  inbound events through the existing retargeting on transfer and takeover.
- A public URL is a prompt injection channel into an agent with local
  execution rights; fencing, labeling and manual-bounded actions reduce but do
  not eliminate the risk.
- High-volume subscriptions consume the assistant's bounded Session cache and
  turns; rendering budgets and backlog limits trade completeness of
  notifications for conversation retention.
- Per-instance rate limiting is approximate across server instances; the
  database backlog limit is the hard bound.
- Local deployments cannot exercise the self-subscription path end to end;
  that path is accepted on a public deployment.
- Bot identity on Task, Step and Thread writes is a same-user declaration, not
  a security boundary; a same-user process can omit it and avoid suppression.
- The ten-minute reaction window is a heuristic: a reaction after the window
  is delivered, and an unrelated write inside the window is suppressed.
- Two concurrent creations can still produce two personal endpoints targeting
  one inbox while the subscription panel creates endpoints without a key. Inbox
  idempotency prevents duplicate inbound events. The Webhook endpoint contract
  now provides an atomic per-owner [creation key](2026-11-21-webhook-endpoint-client-key.md);
  the panel closes this gap once it creates and finds its endpoint by that key.
