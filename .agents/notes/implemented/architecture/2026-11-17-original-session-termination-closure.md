# Agent Note: Preserve the Complete Original Session Termination Closure

Status: implemented

## Problem

A stopped registered run does not establish that the original Session cannot
resume or that every launched generation is represented in the remote ledger.
A process can stop after its launch but before registration, and observing it
later cannot establish whether a policy change preceded the Session's closure.
Recording content, archive publication and worktree cleanup have different owners
and cannot serve as proof of the complete execution boundary.

## Decision

The Worker retains a source-independent inventory of original Web and managed
Herdr execution identities and stop evidence. After the original claim cannot
resume, all launch and native operations have joined, and every started run has
trusted stop proof, the backend freezes a closure with its original identities,
highest generation, stable identifier, digest and local ordering identity.
Unknown launch or stopping evidence remains unknown. Closure prevents further
launch or recovery under the original Session. It does not itself assign a
server terminal sequence or select a recording for deletion.

Worker and independent Controller metadata writers share a durable ordering
domain. A closure intent and its sequence survive the gap between the domain and
backend SQLite commits; recovery reconciles that original intent before a policy
cut or a new generation can pass it. A prepared cut retains its activation
identity until resolved. Physical stop proof can still be recorded during the
wait, while closure waits on the cut. The [Worker design](../../../../docs/design/daynight-worker.md#原-session-的终态元数据)
owns the ordering and recovery contract; the [Herdr lifecycle](../../../../docs/design/herdr-worker-lifecycle.md#停止-journal-与原进程证明)
and [Controller design](../../../../docs/design/task-session-protocol.md#controller-与原生会话)
own their backend evidence.

## Alternatives

**Use the currently registered stopped runs.** This omits a launched recovery
whose ledger submission was lost and can treat a recoverable shutdown as final.

**Order by later archive discovery or worktree cleanup.** Either can be delayed
or fail independently of the original stop, so the resulting policy decision
would depend on maintenance timing instead of the original execution boundary.

## Consequences

The retained metadata and cross-process permit add storage, recovery and
serialization responsibilities. An unconfirmed closure commit or incomplete
original identity cannot be guessed and retains its explicit recovery obligation.
The local closure is independent of recording contents and does not alter archive
or worktree cleanup ownership. Policy activation and remote terminal publication
remain separate responsibilities.
