# Agent Note: Client Command Composition

Status: implemented

## Problem

The package's root entry and shared dependency object were organized around a
continuous PR reviewer. Other client commands would inherit review configuration,
paths or execution dependencies even when their operations did not use them.
Source ownership also made SQLite the provider of domain types and combined
remote GitHub queries with local observation commits. These relationships make
adding an independent command require changes to unrelated review assumptions.

## Decision

`@codetreker/daynight` is a client command toolkit with `daynight` and `dn` bins
pointing to the same stable entry. The [short-command decision](../../implemented/feature/2026-10-22-dn-short-command.md)
owns the additional installed name and completion registration.
The root application owns help, version, command selection and general exit
results. Its context contains package version, the package directory determined
by the stable `main.ts` entry, input/output, and lazy home/working-directory
queries; it does not contain resolved review paths, configuration or runtime
functions. Business-free definition modules declare each command's name,
description, aliases, options, positional arguments and fixed choices. The root
registry combines those definitions with lazy execution loaders. `cli/schema.ts`
uses the same definitions for parsing and help; the Bash and zsh generators also
consume this command tree. Each selected command owns its dependencies and
lifecycle. Definition modules cannot import business implementations or perform
configuration, filesystem, database or adapter operations.

`review` owns the existing PR-review capability. Its group shows help, `run`
starts foreground monitoring, `list` and `ls` inspect local persisted state, and
`add-repo <remote> [--path <path>]` saves repository configuration. The former
`--daemon-review` and root `add-repo` entry forms are invalid. The command change
is shipped as package version `0.3.0`; no legacy forwarding wrapper preserves a
second command model. `update` remains a root command because it manages the
whole client installation. `completion` generates native shell scripts as a root
command. Each group and operation handles help before loading its business
implementation. Help retains its sole-argument rule, and metadata-driven parsing
preserves the accepted operation syntax.

Review code lives under `commands/review/`; its GitHub, worktree and Copilot
adapters belong to that module. `model.ts` owns domain and safe-recovery proof
types independently of the SQLite implementation. `polling.ts` composes remote
queries, repository registration, atomic store updates and failure recording;
GitHub queries do not receive the store. `commands/update/` owns self-update.
Shared diagnostic, filesystem and data-level skill-bundle functions live under
`platform/` and do not import command modules. Tests mirror those responsibilities, with tooling tests
kept separately.

The emitted entry remains `dist/main.js`, and the updater receives the package
directory from that stable entry rather than computing it from its nested
module location. Builds remove `dist/` before TypeScript compilation so moved
source modules cannot survive as stale distribution files. The build cleanup
script is a release input under the existing package-version gate.
The [bundled review skill](2026-10-20-bundled-review-skill.md) extends the build
with complete review-owned resource copying and uses the same stable package
directory to capture runtime instructions. Its resources remain local to the
selected review command and do not change the root context's business ownership.

YAML fields, version 1 SQLite tables, data locations, repository paths, cutoff
boundaries, revisions, retry budgets, session UUIDs and worktree ownership stay
unchanged. Source ownership does not partition user data by command. The current
scope supplies command composition and the review, update, login/logout,
completion, skill, project and task capabilities. The
[public skill design](2026-10-21-public-agent-skill-design.md) owns its bundle and
interactive installer; it needs no server or review configuration. Shared
`cli/prompts.ts` supports typed selections, and `cli/cancellation.ts` owns the
short-lived review-guidance/skill signal and prompt lifecycle. The
[guided setup decision](../feature/2026-10-21-guided-configuration-setup.md) originally
extended the independent configuration capabilities with a root setup command
and preflight at affected business entries. The
[top-level setup removal decision](../../implemented/simplification/2026-10-25-remove-top-level-setup.md)
keeps review guidance in its owning module and removes the generic entry. Server API commands were separate product work in the
command-composition scope. The adopted
[project/task CLI design](2026-10-20-project-task-cli-design.md) now defines that
consumer and its additive configuration and repository binding. Shared
configuration, bounded HTTP, repository bindings and project commands are
delivered; task command composition is delivered. The
[bounded ready selection decision](../feature/2026-10-21-bounded-ready-task-selection.md)
extends that module with `task ready [--limit <N>]`, using the API client
`listReadyTasks` operation without changing the complete-list contract. Its
limit validation finishes before server configuration, Git or HTTP is loaded.
Task definitions extend shared value metadata for empty descriptions, fixed
statuses, ordered repeated dependencies and inline text assignment. Adding these operations must preserve
per-command loading and ownership so they do not become startup dependencies for
existing commands.
Independent server and web lifecycles retain their current owners.

The [client requirements](../../../../docs/spec/daynight.md) and
[client design](../../../../docs/design/daynight.md) own the shell and package.
The [review requirements](../../../../docs/spec/daynight-review.md) and
[review design](../../../../docs/design/daynight-review.md) own review behavior.
This decision partially supersedes the package-wide review framing in the
[foreground review decision](2026-10-16-foreground-review-cli.md), while retaining
its polling, direct-child execution, retained-session and agent-publication
model. The [home-layout decision](2026-10-16-user-home-review-configuration.md)
and [self-update decision](../feature/2026-10-20-cli-self-update.md) retain their
location and installation-ownership guarantees. The
[shell-completion decision](../feature/2026-10-20-shell-completion.md) extends the
metadata ownership to parsing, help and native shell generation while preserving
per-command business loading.

## Alternatives

**Keep one root router and add new command branches.** This retains a convenient
central dispatch point, but a root dependency contract containing review
configuration and runtime would make every future command participate in review
wiring. Feature-owned modules keep those dependencies at the operation that
uses them while the root still has one dispatch entry.

**Publish independent npm packages for every command.** Independent packages
could separate release and dependency installation, but would require several
installation/update lifecycles and lose the requested unified client command.
The current capabilities share one package while loading their runtime modules
only when used. Separate packages remain a different distribution decision if
release ownership or dependency installation requirements change.

**Partition configuration and state under review-specific disk paths.** This
would align disk names with source modules but require a data migration and
change the meaning of established paths and locks. Keeping the confirmed
configuration/state format makes the command and code reorganization independent
of stored-data ownership. A future data-layout decision needs its own migration
requirements and evidence.

## Consequences

A new command adds a definition, registration and its own module; the root
application does not learn its business dependencies. Help, version, update and
completion remain independent of review configuration, SQLite and review
executables. Definitions are loaded for command discovery and shell generation,
so keeping them free of business imports is an enforced dependency boundary.
Registration and listing retain their distinct side effects, and foreground monitoring alone owns its
long-running review signal and runtime lifecycle. Short-lived review guidance
and skill interactions use the shared CLI cancellation owner.

Operators use the canonical review group commands. Existing configuration,
state and sessions remain directly usable at their original locations. Tests
must exercise an independently constructed existing-schema fixture, rather than
create all baseline data through the current store. Native Git, SQLite, process,
APFS and installed review workloads retain their existing acceptance criteria.
Self-update must still prove actual installation ownership and fresh-process
version after its source move. Source-bound JSON receipts and their corresponding
PR or CI run distinguish current-source observations from historical results.
Controlled process behavior does not establish real Copilot judgment or GitHub
publication; the [installed acceptance decision](../testing/2026-10-17-installed-cli-acceptance.md)
retains that separate live-service requirement.

One package still installs the dependencies of all its commands. Lazy loading
isolates execution and native-addon ownership, not installation size. The shell
is a small command registry, not a plugin framework or a promise of arbitrary
external command discovery.
