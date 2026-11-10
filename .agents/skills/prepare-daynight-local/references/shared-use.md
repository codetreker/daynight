# Share the Retained Environment

A retained local environment — the site, development root, test persona,
development Worker and test repository — can serve agents other than the one that
prepared it. A production Worker's agent that delivers a UI fix, for example, can
reproduce the original failure and verify the fix against the same real services.
Because these agents run concurrently with the environment's owner and with each
other, shared use follows these rules.

## Use the environment without changing it

- Use the recorded public origin, explicit development root and test persona. Do
  not create identities, tokens, development roots or Worker enrollments, and do
  not print credentials.
- Create only owned, uniquely marked fixtures and Test Sessions. Before finishing,
  stop and archive your Test Sessions and remove your disposable worktrees under
  [the Test Session procedure](test-sessions.md#stop-and-clean-up).
- Do not stop, restart, rebuild, refresh or reconfigure the site, database,
  identity fixture, development Worker or its cloud configuration. Do not modify
  other agents' fixtures or the test checkout.
- A candidate frontend can be compared without changing the shared server: serve
  its documents and static assets to an owned browser context while API and
  WebSocket requests reach the real service. Label such evidence with both the
  candidate revision and the server revision.
- Report an environment failure to the owner instead of repairing shared services.

## Describe the environment safely

Task material may name the origin, development root path, persona and build
identity so that an implementer can reproduce a finding. It never includes
credentials or the contents of private configuration.

## Check for users before changing the environment

Before stopping, refreshing or replacing a component, the owner checks:

- online Test Sessions on the site;
- Controller processes started with the development root or its snapshots,
  identified by launch arguments and parent process rather than by name;
- recently modified execution state under the development root;
- the development Worker's active claims and task inventory.

Wait for active users or coordinate with them; do not terminate their processes.
Archived sessions and execution records accumulate as product and state data.
Remove them only within explicitly scoped cleanup.
