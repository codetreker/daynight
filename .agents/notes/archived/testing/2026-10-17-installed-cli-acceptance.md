# Agent Note: Installed CLI Acceptance

Status: implemented

## Problem

Module tests can pass while a packed distribution omits runtime files, resolves
dependencies differently or fails through a platform command shim. Final review
delivery also needs evidence that separates controlled process behavior from
actual Copilot reasoning and GitHub effects.

## Decision

`pnpm acceptance` builds the application and runs independent review, self-update
and project/task installed suites. The
[project/task acceptance decision](2026-10-20-installed-project-task-acceptance.md)
owns the third native suite and separate real-service path. Local and hosted
validation pass with the original review and self-update workloads
retained; [PR #55](https://github.com/codetreker/daynight/pull/55) owns review and
integration status. The review lifecycle suite
packs and installs the application into a
project-local consumer, then drives its installed `daynight` command. It uses
real Git and SQLite with controlled `gh` and Copilot executables. It injects no
runtime or coordinator dependencies and adds no product test flags. The
[bundled review skill](../architecture/2026-10-20-bundled-review-skill.md) is
loaded from the installed package: the controlled Copilot executable answers
native discovery and checks that each review receives the immutable snapshot.
Those discovery calls are separate from the simulated agent invocations and
publications. Replacing only the isolated installed asset leaves the running
daemon's captured bytes intact; orderly restart captures the new digest while
retaining the same PR UUID. The
[self-update suite](../feature/2026-10-20-cli-self-update.md) uses real npm with
isolated task-local global prefixes and a controlled scoped HTTP registry; it
checks replacement of the invoked installation without changing the operator's
installed CLI.

Windows `execFile("gh")` receives a native executable: a copy of the existing
Node binary preloads a bounded fixture module before resolving the absent API
entrypoint. The ordinary Copilot command shim remains on PATH. Temporary home
and working directories exercise spaces and Unicode. Git protocols are limited
to the exact local fixture origin, and live credentials are removed from the
controlled environment.

The installed fixture also covers root, group and operation help before review
state exists. An independent YAML, schema-version-1 SQL and retained-state seed
exercise installed `review list` and `review ls` without calling the current
store to create the baseline. Both aliases must retain configuration bytes,
schema and rows while preserving cutoff, revision, session, retry and cleanup
attribution. This establishes stored-format reuse for the read path; runtime
recovery keeps its separate full-lifecycle and module coverage.

The fixture uses `review add-repo` to register repositories, checking explicit
relative paths, default-root derivation, fixed paths after a root change and
configuration-only effects before starting `review run`. It drives both installed
status-listing aliases before initialization, during Draft and completed states,
and after closure. Those calls use a restricted PATH without Git, gh or Copilot
and verify that the listing remains a local state read beside the running reviewer.
It also drives triggers, exact session continuation, publication ownership,
missing-marker reconciliation, installed live-singleton refusal, abnormal-lock
diagnostics, automatic dead-owner restart and worktree cleanup. The
[stale-lock decision](../bug-fix/2026-10-18-stale-instance-lock-recovery.md)
keeps uncertain review and cleanup resources blocked after that restart. The
abnormal-exit fixture waits for current direct tool handles to drain,
acknowledges the actual CLI PID and exits
synchronously before the runtime can release its lock. A native child verifies
the public `ProcessWrap` visibility used by that gate on each platform. This
is a controlled fault-injection point; ordinary native process-tree cancellation
keeps its own unchanged tests. The [repository validation guide](../../../../README.md#validation)
owns repeatable commands, receipt meanings and tested-baseline limits. The
corresponding PR and CI run retain source-bound scenario results under the
[validation evidence decision](../process/2026-10-20-source-bound-validation-evidence.md).
The live-service limits remain independent of controlled fixture success.

The existing installed suites perform normal registry dependency resolution. The pnpm
store alone cannot satisfy a fresh consumer's offline metadata lookup after a
frozen workspace install. The self-update registry controls package versions
and tarballs while npm installs their real dependencies. The ordinary
`pnpm check` remains independent of these additional installations. See the
inspected [pnpm resolver](https://github.com/pnpm/pnpm/blob/702ad5f860ffd50d64a3a711d9f8a3da16fc796e/resolving/npm-resolver/src/pickPackage.ts#L143-L179).

Native CI runs the ordinary and installed commands and uploads only the
environment, review lifecycle, self-update and project/task JSON receipts. The environment
manifest selects version and OS fields; it never serializes the full process
report or environment. Self-update writes `.tmp/update-evidence.json` separately
from the lifecycle receipt. The
[pinned artifact action](https://github.com/actions/upload-artifact/blob/cf430e030ddbb5b0abf93d22962f4752f3646cd9/action.yml)
includes only those explicit paths. The final matrix gate remains authoritative,
including fixture cleanup and failed assertions.

## Alternatives

**Validate only source modules or a linked checkout.** This misses package-file
selection, consumer dependency layout and generated installed command shims.
Packing and normal consumer installation exercise those public boundaries.

**Seed an offline consumer by constructing lockfile/cache metadata.** That adds
pnpm internals to a distribution test and bypasses ordinary resolution. An
explicit registry-backed acceptance stage keeps the package installation real
while ordinary tests remain separate.

**Treat a simulated publication as a live-service receipt.** Controlled responses
prove orchestration and the text/session protocol, but cannot prove model
judgment, entitlement or GitHub authorization. Live acceptance retains its own
repository, reviewer and write-authorization requirements.

## Consequences

The same installed lifecycle can run on native Linux, macOS and Windows without
review credentials or global installation. Self-update acceptance uses task-local
global prefixes on those platforms. CI artifacts identify the tested toolchain
and distinguish controlled update replacement from lifecycle receipts whose
live-service flags are false.

Package-registry access is required for acceptance. Local fixture success does
not extend OS/architecture support beyond observed receipts. Real Copilot and
GitHub acceptance remains outstanding until the designated test effects are
authorized and observed.
