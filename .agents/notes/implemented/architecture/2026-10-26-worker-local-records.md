# Agent Note: Worker Identity and Local Claim Records

Status: implemented

## Problem

A worker must retain its identity across restarts, locate the repository for an
acquired claim and remember which resources it is responsible for stopping.
After a process failure, a lost configuration snapshot, cleanup deadline or
control intent can cause a second execution, a changed model or reconstruction
of resources that were deliberately deleted. Independent local task registries
would make these decisions depend on conflicting persistent facts.

## Decision

The [worker design](../../../../docs/design/daynight-worker.md#配置与目录) fixes
worker resources under `~/.daynight/worker/` and stores a random stable root
`workerId` in shared `~/.daynight/config.yml`. Identity creation uses the
existing configuration lock, rereads under that lock and atomically updates the
YAML without replacing other configuration. An existing valid identity is reused
without rewriting; an invalid identity is exposed as an error.

The worker instance lock uses the same worker `state.sqlite` as its SQLite gate.
It adds no lock table or second database. The narrow platform lock primitive is
shared with review, whose existing paths and database remain separate. A stale
worker PID permits lock reclamation but does not prove that native agents or
their processes stopped.

The [store](../../../../packages/daynight/src/commands/worker/store.ts) has only
`projects` and `tasks`, with WAL, synchronous FULL, STRICT tables and immediate
transactions. Projects bind server origin/project to repo/path before claiming.
The initial storage decision kept automatic acquisition identity in memory and
relied on complete own-claim inventory before pending registration. It
introduced no preclaim task or extra acquisition registry. The [foreground
runtime decision](2026-10-27-foreground-worker-runtime.md) partially supersedes
the memory-only part: projects now retain one concrete unresolved claimAttempt,
including original IDs, exact version and decision configuration, before the
outbound mutation. Matching actual ownership atomically materializes pending and
clears that attempt. Unknown requests remain fenced; absence alone does not
clear them. Transfer still persists its target identity in source control
intent. The two business tables and actual-claim-only task rows remain.

Each task row corresponds to an actual claim and retains its original repository
binding, frozen configuration, resource associations, concrete nativeExecution
provenance, recovery state, cleanup and source control intent. Status is
pending, active or done. A partial unique index permits at most one active claim
per origin/project/task. Completed rows remain history; no event table or
alternate execution registry is introduced.

First pending materialization freezes effective agent/model/args/recovery limit.
A recovered execution missing its original snapshot pauses until that original
configuration is explicitly restored. Resource bindings follow committed active
state and retain worktree and native identity. Replacing a Herdr binding
requires confirmation that the original agent stopped and old workspace closed.

Concrete cleanup operations retain the first deadline, input uncertainty,
result/error and ordered stop/close/delete confirmations. Local done requires
full terminal cleanup. Release/transfer intent prevents ordinary recovery;
remote submission requires full cleanup and the original exact version. Unknown
writes cannot be replayed. Versions persist as exact int64 decimal strings.
Complete own-claim inventory can confirm original ownership ended without a
per-task read to classify the exit.

Normal shutdown differs from an ownership exit: after agent stop and workspace
closure it preserves the original worktree/native/config. Consuming that
shutdown clears stale Herdr and stop facts atomically while retaining recovery
count, pause and retry authorization. It does not consume fault-recovery budget;
terminal cleanup cannot be consumed as ordinary restart.

This partially supersedes the configured state-root and worker_state/executions
storage design in the [earlier worker decision](2026-10-22-worker-design.md).
That design tried to give each workspace an explicit resource owner and use
external-action checkpoints to preserve uncertainty. The fixed per-user identity
and concrete per-claim fields retain those responsibilities without another
worker singleton row or generic action engine. The [current-claim
inventory](2026-10-26-worker-claim-inventory.md) and [agent
completion](2026-10-26-worker-managed-completion.md) decisions continue to own
discovery and final business completion.

## Alternatives

**Use an explicitly configured workspace state directory.** The initial design
kept new worker resources inside an operator-selected workspace. Multiple roots
would also permit multiple identities and instance locks in one user
environment. A fixed root makes one worker's identity, exclusion and recovery
location predictable without another configuration choice.

**Persist worker_state and executions with pending_action records.** The initial
schema modeled a singleton worker and generic service/task action checkpoints.
The required consumers instead need a project mapping and concrete per-claim
facts. Two business tables keep those facts together without a generic action
protocol, task queue or second local ledger.

**Use SQLite snapshots and retain source resources for transfer.** That approach
would require source/target preparation, original native history and continuity
of unpublished files. An ended claim is terminal locally: it receives the same
stop/close/delete sequence regardless of done, release or transfer. A target
materializes only an actually granted new claim and starts a fresh execution;
file transport and target pre-staging are outside the store.

## Consequences

Real SQLite transactions preserve committed responsibility, immutable snapshots,
fixed cleanup deadlines and exact control decisions across process interruption.
The store does not prove external resource state; Git, Herdr and the coordinator
must supply those observations and serialize each claim's actions. Failed or
partial claim inventory cannot authorize deletion. The original claim's absence
from a successful complete own-current inventory is the automatic cleanup rule.

The [foreground runtime](2026-10-27-foreground-worker-runtime.md) consumes these
identity/storage operations and concrete native facts. The [Git workspace
manager](2026-10-26-worker-git-workspaces.md) supplies concrete worktree
observations and returns bindings to this same store. Existing service
resume/transfer continuity checks still need the management-protocol delivery
before fresh target execution is available. This local schema does not claim
that protocol change, native-agent recovery or Windows/macOS runtime acceptance.
Schema 1 migrates explicitly to schema 2; missing original native evidence stays
unknown rather than receiving never-submitted defaults. Unsupported or
inconsistent schemas fail visibly.
