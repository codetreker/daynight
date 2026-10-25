# Agent Note: Guided Configuration by Command Capability

Status: implemented

## Problem

When this decision was adopted, a new CLI installation required a service origin
for project/task calls and a registered repository for review. An absent file
reported a filesystem error without helping an interactive operator provide the
required values. Requiring every machine to configure every capability burdens
machines that only need one. Configuration changes must preserve unrelated
settings and must not activate runtime resources.

## Decision

Review run/list operations guide an absent file or `repositories` field only when
stdin and stderr are terminals. Complete configuration executes directly.
Shared YAML/schema errors, invalid selected values, empty review repository lists
and ordinary read failures retain their errors; unrelated capability values stay
outside the current projection. Noninteractive missing review configuration gives
an explicit setup command. No common initialization-complete marker is stored.

The original design also guided a missing service origin and offered a
server/review/both choice in plain `daynight setup`. The
[device-login decision](../architecture/2026-10-25-cli-device-login.md) replaces
that service branch with the production default and explicit login/logout.
Plain setup now collects review configuration. Explicit `--server-url`,
`--review-repo`, optional `--review-path`, and `--server-token-stdin` retain
noninteractive configuration; a path requires its repository. A service-only
machine needs no review configuration. The
[client requirements](../../../../docs/spec/daynight.md#c6-按需配置引导) own the
current behavior and the [client design](../../../../docs/design/daynight.md#按需配置引导)
owns composition.

Input collection precedes mutation. One transaction takes the configuration lock,
rereads the latest document, checks selected fields against their observed values,
validates the merged result and replaces the file atomically. A selected-field
change fails explicitly; completed changes to unrelated fields are preserved.
Origin and token are observed together, with a changed normalized origin clearing
the old credential atomically. Comments, other capabilities and existing
repository paths remain. Credential-bearing results use POSIX `0600` for every
writer, as required by the
[credential decision](../architecture/2026-10-22-cli-server-credentials.md).
Files without a token keep their existing permission behavior. The
[registration decision](2026-10-18-add-repo-configuration.md) owns repository
identity, paths, idempotency and its shared updater.

Prompts and save diagnostics use stderr, preserving machine-readable stdout.
The shared CLI prompt/cancellation lifecycle also serves
[skill installation](../../../../docs/design/daynight-agent-skill.md).
Cancellation signals or EOF stop input without partial saves or original business
execution. Setup does not access the network, prepare clones, initialize SQLite
or start review. After successful review guidance, the original operation executes
once with its original arguments. Human input consumes no business budget, and
a later failure keeps the saved configuration.

The original guidance partially superseded startup prerequisites in the
[user-home decision](../architecture/2026-10-16-user-home-review-configuration.md)
and [project/task decision](../architecture/2026-10-20-project-task-cli-design.md).
Explicit preparation had avoided implicit writes and exposed configuration errors;
guidance retained those error/runtime boundaries while adding interactive
collection. The file location, review state format and capability projections
continue unchanged.

## Alternatives

**Require manual setup before every first command.** It keeps preparation
explicit but reports an absent file before a new operator learns the available
configuration command. Scriptable setup remains available; interactive review
commands collect the same values when needed.

**Configure service access and review together on every machine.** It could
establish one initialization state but requires repository registration on machines
that never review. Independent projections permit separate use, and the default
production origin removes the service-address initialization requirement.

**Save every answer immediately.** Cancellation could leave a partial setup,
and separate writes could overwrite intervening changes. Collection followed by
one locked reread/replacement preserves a single configuration transaction.

## Consequences

Interactive review use can continue from required configuration to the requested
result, with stdout and runtime ownership preserved. Service use follows explicit
device login, without an address prompt. Current command requirements are checked
independently, and invalid configured values remain visible.

Prompt and persistence lifetimes stay separate. Input finishes before acquiring
the write lock; business startup follows persistence. Concurrent writers can fail
on the existing fail-fast lock. Manual editors do not participate in that protocol,
and abnormal lock recovery retains its operator checks.

The original service-input path released its initial operation deadline during
human input and restarted the business budget after saving. Service commands now
resolve their effective origin and credential within the ordinary business budget;
device login has its own deadline. The original hidden credential-input extension
kept setup independent of network state; current stdin setup retains that rule.
Deployment, connectivity validation and live reviewer reload have their own
owners. Business errors remain visible, and authentication errors never cause an
anonymous retry or mutation replay.
