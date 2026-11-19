# Agent Note: Assistant Task Inbox

Status: proposed

## Problem

Assistant tasks can hold a long-running responsibility, but an assistant only
learns about Project activity by polling or by being told in chat. External
systems have no way to notify an assistant, and Daynight's own outbound
Webhooks can only reach public HTTPS receivers, while assistants run on Worker
machines that are usually unreachable from the internet. Assistants also lose
what they learned whenever a Session is compacted, evicted from its bounded
cache, or taken over by another Bot, so repeated work does not improve.

## Proposal

Give each assistant task an optional inbox with a public URL on the Daynight
server, as specified in
[the inbox specification](../../../../docs/spec/assistant-task-inbox.md) and
[its design](../../../../docs/design/assistant-task-inbox.md). Requests become
`inbound` assistant task events for the current holder Bot and travel through
the existing Worker event delivery. A Project event subscription is an ordinary
personal outbound Webhook endpoint whose URL is the inbox URL. Daynight events
are authenticated by comparing the request bytes with the captured event fact
on the server and confirming that one of the owner's personal endpoints targets
this inbox. Captured events store their authenticated actor on the server, and
Task, Step and Thread writes accept an optional Bot identity, so an inbox
suppresses events caused by its holder Bot and events caused by another of the
owner's Bots shortly after that Bot was notified about the same Task. Work records gain an `outcome`
kind, retrospectives are generated without a server scheduler, and appendix
entries gain scope and validation counts so experience survives Sessions.

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

**Sharing the endpoint signing secret with the inbox.** Verifying the Standard
Webhooks signature would require users to copy and rotate a secret in two
places. Comparing the body with the stored event fact proves origin without any
shared secret, at the cost of classifying redeliveries after fact retention
expires as `external`.

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

**Suppressing only the holder Bot.** Two assistants of the same user that
subscribe to the same Project would wake each other indefinitely, because each
hop is caused by a different holder.

**Suppressing every Bot of the owner.** This stops cross-assistant loops but
also hides genuine Project work done by the user's other assistants, which is
a primary thing a monitoring assistant needs to see. Suppressing another Bot's
event only when that Bot was notified about the same Task within ten minutes
targets the reaction that forms a loop and keeps independent work visible.

**Relying on the assistant to ignore its own events.** Prompt-level discipline
cannot bound a feedback loop when the assistant replies to a Thread event with
a Thread post. Server-side suppression plus rate and backlog limits bound it
mechanically.

## Acceptance Criteria

- The inbox, receiving endpoint, server-side actor capture, suppression,
  Worker rendering, subscription UI and learning features behave as the
  specification requires, verified by the tests named in the design.
- A real outbound Webhook on a public deployment delivers to its own inbox,
  retries and manual redeliveries create no duplicates, and the holder Bot
  receives a compact notification when idle.
- Tokens never appear in logs, errors, events or inbox read results; the
  token-bearing URL appears only in enable and rotate responses and in the
  owner's own endpoint configuration and delivery history.

## Risks

- A public URL is a prompt injection channel into an agent with local
  execution rights; fencing, labeling and manual-bounded actions reduce but do
  not eliminate the risk.
- High-volume subscriptions consume the assistant's bounded Session cache and
  turns; rendering budgets and backlog limits trade completeness of
  notifications for conversation retention.
- Per-instance rate limiting is approximate across server instances; the
  database backlog limit is the hard bound.
- Local deployments cannot exercise the self-subscription path end to end.
- Bot identity on Task, Step and Thread writes is a same-user declaration, not
  a security boundary; a same-user process can omit it and avoid suppression.
- An `immediate` token rotation drops pending retries and redeliveries that
  still carry the old URL; `overlap` keeps the old token valid for 8 days and
  refuses a second overlap rotation within that window.
- The ten-minute reaction window is a heuristic: a reaction after the window
  is delivered, and an unrelated write inside the window is suppressed.
