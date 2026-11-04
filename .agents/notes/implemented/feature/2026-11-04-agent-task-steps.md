# Agent Note: Project-defined Task Step maintenance

Status: implemented

## Problem

Task Steps persist across Sessions, but an Agent needs to know which work belongs
in them, when to maintain separate iterations and how to reconcile a write that
may have committed. Without that guidance, transient execution logs or permission
could be mistaken for durable work records, and a completed review could be
mistaken for a successful review or a completed Task.

## Decision

The canonical `using-daynight` resources assign content ownership to task-content,
operations to task-management, shared parent-version and unknown-write handling
to write-safety, and maintenance during execution to task-execution. The entry and
handbook navigate those owners. The independent `daynight --skill` manual includes
the same project-defined workflow and the delivered CLI operations. Project rules
choose names, granularity and timing; prelisting and appending coexist, and
separate rounds retain independent records. Step status, order and review outcome
remain distinct, and Step writes confer no execution or delivery authority.

## Alternatives

**Encode a fixed sequence or synchronize Session todos.** That would impose one
project's workflow on others and turn transient execution state into durable
records without an explicit decision. Project rules and explicit writes retain
both flexibility and ownership.

**Keep workflow guidance only in the standalone manual.** Agents using the
installed skill would not discover the execution and content rules through their
existing owners. Navigation and a concise manual summary keep both distribution
surfaces usable while the skill references own detailed workflow guidance.

## Consequences

The same rules apply to ordinary and managed execution without a new mode. A
Step is not an audit log; overwritten or deleted content is not publicly
recoverable. Version conflicts require a fresh decision, and unknown outcomes
remain unknown after a current-state read. Packaging and installation checks prove
resource bytes and discovery; semantic review assesses the instructions separately
and cannot prove an Agent will follow them.
