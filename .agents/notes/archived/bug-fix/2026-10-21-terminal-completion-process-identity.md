# Agent Note: Terminal completion follows the original child

Status: implemented

## Problem

Native skill installation acceptance can report that an installed launcher
remains alive after its terminal has completed. A numeric PID identifies a
process only during that process's lifetime. Windows can reuse the identifier
before terminal output finishes draining, so a later `process.kill(pid, 0)`
probe can observe another process and incorrectly reject a completed launcher.

The [native terminal acceptance decision](../testing/2026-10-21-native-skill-terminal-acceptance.md)
owns terminal interaction and stream separation. This decision owns the evidence
that its original installed launcher has exited.

## Decision

The terminal bridge records the original ChildProcess's `exit` event and writes
that receipt together with its `close` result. The acceptance helper requires a
reported exit code or signal and exact agreement between the original child's
exit and close results. Missing or contradictory evidence fails acceptance.
The numeric launcher PID remains diagnostic information and is not probed after
completion to establish the original child's identity.

Node's [process exit callback](https://github.com/nodejs/node/blob/f14cd3aa7bf9ca8df2cc5b8bb14beb0f335b1d93/lib/internal/child_process.js#L300-L335)
closes the original process handle and emits `exit` before completing stream
cleanup. Windows [process handles and identifiers](https://learn.microsoft.com/en-us/windows/win32/procthread/process-handles-and-identifiers)
have different lifetimes: handles retain the process object until closed, while
the identifier is valid only until process termination. Recording events from
the original ChildProcess retains that ownership across terminal draining.

## Alternatives

**Continue checking the saved PID after terminal completion.** A successful
probe cannot distinguish the original launcher from a later process that
reuses its PID. Repeating that probe cannot recover the lost process identity.
The bridge already owns a ChildProcess with a specific exit notification, so a
second identity-free liveness observation provides weaker evidence.

## Consequences

The fixture verifies original-child completion without depending on PID reuse
or extra timing delays. Terminal topology, stdout separation, exit status,
interaction assertions, deadlines and forced cleanup of unfinished terminals
remain required. The receipt proves this launcher's exit; it does not identify
arbitrary descendant processes after they lose their ownership relationship.

The bridge result gains an exit receipt consumed by the acceptance helper.
Linux validation can exercise the receipt and result assertions, while Windows
ConPTY behavior still requires hosted native acceptance on the delivered source.
