# Build Minimal Local Fixtures

Use fixtures to expose a user path, not to populate every possible product state.
Follow [repository preparation](test-repository.md),
[local identity](local-identity.md) and [environment verification](verification.md)
before a write. Use the canonical Daynight CLI through the verified development
entry or test-repository router, with explicit development root, loopback origin
and project ID. Fixtures belong only to the selected localhost service.

Do not seed production, write directly to the database, forge Session records or
edit Worker state to manufacture a view. A browser-only mock can explore a
proposal, but must be labeled and cannot prove a real product lifecycle.

## Keep the fixture set attributable

Choose a unique, nonsensitive marker before creation. Keep a small resource
inventory beside the private environment record under ignored `.tmp/`; record
only identities and observations, not credentials or full configuration.

| Resource | Record |
| --- | --- |
| Environment | Selected source and running build; exact public origin; explicit development root and test persona |
| Project | Full local ID, repository identity and reused/created ownership |
| Task | Full local ID, unique marker, purpose, observed status/version and `allowAgents` |
| Attachment | Owning local task, relative path, purpose and whether created or replaced |
| Runtime, when needed | Expected Worker, Bot/Session and original claim identities, or the Test Session and its workspace; their observed state and why a real execution is required |
| Retention | Retain for inspection, or eligible for explicitly scoped cleanup after verifying no active user |

Read the project and existing fixtures first. A similarly named object is not
necessarily owned by this work. Retain returned IDs immediately; a timeout after
creation is not permission to create another object. Resolve uncertainty against
the same local origin, project, unique marker and full content before retrying.

## Add data in layers

Start at the lowest layer that can expose the behavior. Read back each new object
through the CLI, then navigate to it in the actual website using
[the website guide](website.md). The fixture mutation can use the CLI; a claim
that a UI control works requires interacting with that control and observing
its result.

| Layer | Minimal recipe | What it can verify |
| --- | --- | --- |
| Basic content | Reuse the selected local project; create one uniquely marked `todo` task with `allowAgents=false`, a meaningful description and a long title variant | Lists, detail headers, labels, descriptions, filters and empty/populated transitions |
| Relationships | Add only the additional tasks and ordinary dependencies needed for a chain or blocked state, through supported CLI commands | Chain presentation, readiness explanations, nested navigation and aggregate status |
| Rich content | Add a long Markdown body, unbroken path, or owned attachment at a unique relative path | Wrapping, code/attachment overflow, preview controls and dialog layout |
| Real execution | Use the bounded [CLI/website/Worker loop](local-test-loop.md), selecting the actual test Worker and preserving the original claim | Task-to-Session linkage, real working/completed states, result readback and supported native input |
| Native session without a claim | Start a [controller Test Session](test-sessions.md) for the Provider in scope | Session View states, approvals, interruption and archives with a real Provider |
| Assistant conversation | Create one test Bot through supported product controls on the verified development Worker; send only the bounded prompt the scenario needs | Assistant list/header/detail composition, switching, composer and long conversation behavior |

Task creation defaults to `proposed` and `allowAgents=false`; use explicit `--status todo` when the fixture needs confirmed executable work. Always read back those fields
instead of assuming the default survived concurrent changes. Do not manually
mark a task `in_progress` to make a Session appear. Dependencies and task status
alone do not create an Agent. A Test Session from `daynight controller` does not
establish Worker claim behavior.

Use recognizable but nonsensitive sample content; topic skills describe the
content variations their checks need. Avoid giant payloads or stress-test
inventories as substitutes for representative content.

Example local creation, after resolving the variables under this skill:

```bash
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" task create \
  --title "$DN_FIXTURE_TITLE" --description "$DN_FIXTURE_DESCRIPTION" \
  --project "$DN_PROJECT_ID"
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" task show "$DN_TASK_ID" \
  --project "$DN_PROJECT_ID" --json
```

Use the creation response's full local ID for `DN_TASK_ID`. Load multiline
descriptions from files without shell re-evaluation; preserve literal backticks
and dollar signs. Inspect current CLI help for relationship, Bot or attachment
arguments instead of guessing switches. No automatic fixture generator should
enable execution as a side effect of creating layout data.

## Use real lifecycles when the scenario depends on them

Before enabling any task or starting a Bot, follow the test loop's Worker pool,
effective configuration and native environment checks. A Bot can acquire runtime
resources before receiving a prompt. An online Worker or selected platform alone
does not prove which machine will execute the fixture.

Observe the actual Session and claim returned by that lifecycle. Exercise only
the needed action; do not send an extra model prompt merely to obtain a different
status label. If startup fails, preserve the original claim and native identity,
use the existing [recovery procedure](refresh.md#native-provider-environment-and-retained-executions),
and keep the missing state unverified. Creating a replacement identity can hide
the failure and invalidate switching or recovery evidence.

Prefer naturally occurring empty, loading, disabled and failure states. If a
test requires an induced failure, bound it to an owned resource and document the
mechanism. Intercepted network responses or a prototype's state selector provide
only that simulated-state coverage; never label them a backend failure or a real
Provider response.

## Read back and retain deliberately

After a UI mutation, observe the same resource through the CLI before advancing
the scenario. Preserve the page while the result is uncertain and use its offered
reconciliation control. Task versions, Worker configuration application, Session
operations and attachment bytes have different confirmation mechanisms; use
[the website guide](website.md#reconcile-uncertain-results-and-report-the-loop).

Retain fixtures and evidence for inspection by default. Where cleanup is part of
the request, first reconcile current state and ownership, stop owned activity
through its normal lifecycle when authorized, then remove only disposable
resources with current versions where applicable. Closing a Bot's chat does not
stop or delete the Bot. Task deletion is soft deletion, not storage erasure.
Do not delete Worker-managed worktrees, revoke an unrelated claim, reset identity,
clear shared storage or remove another project's selection as fixture cleanup.

Record what remains, why it remains and any active runtime. Keep runtime
management out of production improvement descriptions; carry only the fixture
recipe and relevant reproduction state into their evidence.
