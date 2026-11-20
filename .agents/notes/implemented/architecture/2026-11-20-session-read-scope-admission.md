# Agent Note: Session Read Scope Admission

Status: implemented

## Problem

Session history, live observations and subscriptions disclose execution content.
Credential permissions must limit those reads without replacing the existing
Session, Task and account checks or changing the accepted history sources.
Long-lived subscriptions can outlast the permission that admitted them.

## Decision

Scoped Session reads carry the original credential authorization to the
existing business admission boundaries. Transaction and snapshot sources read
the current policy for that identity and profile, preserving PAT locks and OAuth
grant-before-access ordering and resource binding. Existing resource checks
remain in force. User channels recheck before each delivery and release the
connection after refusal. HTTP and MCP expose opt-in scoped registration while
the existing production assembly remains unchanged. The
[internal contract](../../../../docs/design/credential-scope-internal.md#session-读取与订阅准入)
describes the affected reads and assembly boundary.

When MCP also enables scoped commands, its combined entry retains the execution
whose transaction-bound command admission was installed. That admission cannot
be replaced or removed, and replacing the service's execution field does not
change the instance used by the registered tools.
The combined Session constructor installs command and producer admission on the
same service, so both checks remain available when scoped routes are assembled.

## Alternatives

**Check only at connection or request authentication.** A subscription or a
read resumed after an external wait could deliver content after its credential
lost permission.

**Hold credential locks during network delivery.** Slow clients would delay
permission edits and tie database transactions to network I/O. A fresh admission
before each delivery preserves the existing I/O ownership instead.

**Enable scoped PAT image status with only read admission.** The status response
can expose a retry action that also requires control permission, and the read can
settle or resume work. Retry also returns the complete state. Until the complete
image authorization is available, scoped PAT status and retry refuse before that
work instead of returning a partial policy.

## Consequences

Scoped callers must provide current authorization sources; missing or mismatched
facts fail closed. Existing Session roles and protocol profiles remain separate
from business scope. Production activation and complete cross-domain route
classification remain with the coordinated scope cutover.
Scoped PAT image status and retry require the guarded command execution; a
read-only scoped assembly remains closed. The [image admission
decision](2026-11-20-session-image-scope.md) records the combined checks and
settlement. Fixed profiles and the existing production entry retain their
original behavior.
