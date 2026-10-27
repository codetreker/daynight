# Agent Note: Worker Project Selection and Registration

Status: implemented

## Problem

A worker can have valid default runtime settings yet no repositories from which
to acquire tasks. Requiring manual repository URLs and paths duplicates Project
identity already owned by the service, while automatically selecting every
accessible Project would remove the operator's execution-scope choice.

## Decision

The parser uses existing runtime defaults for a missing file or omitted worker
settings and an empty acquisition list when repositories are omitted. Only
MissingConfigurationFileError represents file absence; malformed explicit
values, read failures and cancellation remain errors. Reading defaults has no
network or filesystem mutation effects.

The public worker command supplies an explicit configuration-preparation
callback to the runtime. A fresh worker resolves an empty selection before
creating persistent or native resources. A restart with retained state first
establishes its original cleanup controller, so committed deadlines continue
while remote lookup or selection is pending. New task execution waits for a
successful atomic save. Existing accessible Projects supply the choices; name,
UUID and repository URL distinguish them, and HTTP operations finish before
prompting. Startup settings are reread after preparation, while changed service
or credential context cannot rebind the already initialized coordinator.

The repo list/add/remove subcommands manage this selection. Add and remove use
existing remote Project identities, with multiselect for interactive calls and
an explicit --project UUID option for noninteractive calls. No raw repository
URL or Project-creation operation is introduced. Remove changes local
configuration only; it retains clone, SQLite, claim and task resources. The
running worker remains startup-configured rather than hot reloaded.

Registrations save projectId, the server's original repoUrl and an absolute
local path. The shared repository/location module owns root expansion and
portable path components for worker and review. Common identities use the
familiar host/path layout under repositoryRoot, defaulting to ~/daynights.
Transport, user, port and nonordinary path identities retain separate
@remote coordinates. Percent, empty and dot segments are encoded so paths
cannot escape or collapse into another identity. Existing registrations retain
their chosen path when the default root changes.

A selection snapshot covers the repository list, clone root and service/auth
context. Network and prompts hold no configuration lock; the writer rereads
under the existing lock, refuses conflicting relevant changes and applies the
selection to the current YAML document. Unrelated edits and comments survive.
The candidate configuration receives the same type, identity and physical path
validation before atomic replacement. Neither registration nor removal starts
Git, SQLite, native agents or a claim.

This partially supersedes the mandatory configuration-presence rule in the
[foreground runtime](2026-10-27-foreground-worker-runtime.md). Its original
configuration model selected acquisition repositories and native-agent overrides
explicitly. Omission now reaches authentication and Project selection without
requiring an otherwise empty mapping; populated registrations and original
claim snapshots keep their meaning. The runtime continues to own original
claims and resources after this configuration boundary.

## Alternatives

**Finish project selection before opening any retained state.** This makes cold
startup side effects easy to avoid, but a held or failed Project request can
postpone cleanup deadlines already committed by an earlier execution. The
runtime owns the preparation boundary so fresh startup and retained
responsibility receive their distinct ordering guarantees.

**Require an empty worker section and repository list.** That makes operators
spell out values whose default meaning is already known and fails before normal
authentication when the configuration file is absent.

**Default invalid or unreadable configuration to an empty mapping.** That would
conceal malformed settings, filesystem faults and cancelled reads. Only omission
has default-value semantics; explicit invalid input remains visible.

**Automatically register every accessible Project.** This avoids a prompt but
makes service membership determine execution scope without an explicit choice.
A saved operator selection gives add/remove a clear meaning.

**Require raw Git remotes and local paths.** The server already owns Project
identity and repoUrl, so this repeats inputs and makes duplicate or ambiguous
Project matching a manual setup problem.

**Refresh remote Project metadata on each tick.** SQLite already owns durable
project/path bindings and the current task inventory is a separate query.
Configuration-time lookup supplies the selection without changing runtime
reconciliation, request volume or original execution resources.

**Allow offline removal of unavailable remote Projects.** That can clean stale
registrations, but it is a separate exception to operations based on existing
remote Projects. The current commands expose failed remote validation and
preserve configuration rather than inventing that exception.

## Consequences

First-use startup becomes actionable while retaining explicit scope. Parser and
startup regressions distinguish omission from invalid input and verify that
reading defaults leaves configuration unchanged. Scripts use
the Project-ID form before starting; cancellation or missing terminal input
cannot leave a half-selection or start an idle runtime. Remote lookup, prompt
races and saving have distinct failure boundaries, and a selected project must
remain accessible for registration management. Removing configuration does not
release claims or erase their recoverable work.
