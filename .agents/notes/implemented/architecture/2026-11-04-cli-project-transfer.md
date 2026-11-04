# Agent Note: CLI Project Transfer

Status: implemented

## Problem

A Project owner needs to move a Project to a Team they may not belong to while
retaining its identity and independent grants. A transfer can remove the
actor's access, and a lost response cannot establish whether the write committed.
Repository discovery and default Team context must not change the selected Project.

## Decision

The CLI resolves the explicit Project or repository using the existing identity
rules without persisting a binding. It accepts a Team UUID or an exact same-service
Team link, reads a principal-bound preview, and presents the source, destination
and expected actor access before confirmation. The write uses the observed
ownership and destination versions and the actual user ID. A validated receipt,
including null actor access, establishes success without a subsequent Project GET.
An unknown result is reported without automatic replay. The
[service transfer decision](2026-11-04-project-transfer.md) owns the transaction
and access rules; the [client requirements](../../../../docs/spec/daynight-project-task.md#项目转移)
own the command contract.

## Alternatives

**Infer success from a later Project read.** A transfer can remove access and a
404 cannot distinguish a committed transfer from other causes. Current state also
cannot prove which write produced it.

**Persist repository discovery during transfer.** The operation would change a
local binding independently of the remote ownership decision, including on
cancellation or failure. Read-only resolution preserves the existing binding.

## Consequences

The destination need not expose a Team directory or require actor membership.
A conflict requires a fresh preview and decision. A lost receipt remains unknown,
even when current access is absent. Other commands keep their own repository
binding and confirmation behavior.
