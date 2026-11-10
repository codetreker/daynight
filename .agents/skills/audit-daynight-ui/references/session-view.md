# Session View Checklist

Session View appears in task details (the Session tab and its fullscreen), on
standalone Test Session pages and on assistant pages. Its requirements belong to
[Task Sessions](../../../../docs/spec/task-sessions.md),
[controller Test Sessions](../../../../docs/spec/controller-test-sessions.md) and
[the assistant Session view](../../../../docs/spec/bot-session-view.md). Labels
those specifications keep in English and their display-mode rules are expected
behavior, not findings.

Produce real states with prepare-daynight-local's
[controller Test Sessions](../../prepare-daynight-local/references/test-sessions.md)
for each Provider in scope — Codex, Claude Code and GitHub Copilot — and with the
managed test loop for task Sessions. Providers differ in approval content,
interruption results, support for adding to the current turn and todo entries,
so check each Provider separately.

| Area | Check |
| --- | --- |
| Page shell | The list shows online sessions only; back link, title and margins on phones leave room for the Session; archived pages stay readable |
| Header | Provider name and one status; the Display menu (Standard and Conversation, keyboard, Escape); the fullscreen toggle with its tooltip and Escape layering; Refresh; the number of rows on phones |
| Timeline content | Messages with Markdown, code and tables; tool rows with readable summaries, status and expandable input and output; Conversation hiding reasoning and ordinary tools; todo entries; history paging and the latest-position control |
| Interaction cards | Pending approvals, questions and forms readable without raw JSON; actions reachable; resolved and expired cards keep enough context; a way to reach a pending card that is out of view |
| Results and errors | Interruption and cancellation results for each Provider; errors with a summary and technical details; empty states for new and filtered sessions |
| Composer | Idle, Working with Add to current turn, Waiting for an answer, Interrupting…, Awaiting provider confirmation and Executing command; notices that match the actual state; receipts that distinguish delivery in progress from an unknown outcome |
| Settings and commands | Model, Permissions and command menus: labels in the page locale except specified English labels, pending versus applied values, catalog density, keyboard selection, refresh and retry wording |
| Phones | Footer and header rows, primary action position, touch targets, and the timeline's visible height while a menu is open or an approval is pending |
| Archive | Read-only rendering after the Controller stops, disabled writes, and the list no longer showing the session |

Record transient composer states, such as send receipts and interruption
progress, as time series from the triggering action until the state settles.
Command catalogs list the user's own skills and plugins; capture them as geometry
with generic text only.
