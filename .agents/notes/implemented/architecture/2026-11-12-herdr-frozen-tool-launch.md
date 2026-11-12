# Agent Note: Frozen Herdr tool launch ownership

Status: implemented

## Problem

Herdr starts agents by kind through an interactive shell. Selecting an executable
for a version probe alone does not establish which installation that shell runs.
The Worker must preserve native detection, Session identity, terminal behavior and
the original process tree while using a frozen tool selection. Replacing a shared
daemon can also abandon live agents or uncertain startup and shutdown work.

## Decision

Each new execution freezes both Agent and Herdr recipes. A private, owner-bound
manifest maps the existing bare-kind interface to a fixed Node helper, which
starts the verified command with structured arguments and records intent and
receipt. The logical Herdr argv check remains unchanged. The mapping is limited
to the controlled parent shell; native PATH and internal CLI aliases retain their
original meaning. The [tool launch design](../../../../docs/design/herdr-tool-launch.md)
owns the protocol, storage and platform details.

A durable reservation precedes each native start RPC. Only the original caller's
explicit rejection can advance its initialization retry; unknown results retain
the reservation across calls and restarts. Helper intent and receipt also block
replay when they predate that reservation format. Cleanup cannot retire a launch
whose declared helper or native process lacks its original birth proof, even if
the recorded shell has already exited.

POSIX uses non-exported functions in the existing managed Bash without replacing
its process. Windows creates a system PowerShell 5 root pane through structured
layout argv, then uses owned ExternalScript files and a JSON/base64 argument
channel. Node, helper and native processes must remain attributable to the
original shell. Shutdown keeps responsibility for native descendants after their
helper exits.

Private PowerShell 5 process queries reconstruct their system module search path
so an intermediate Node process cannot carry incompatible PowerShell 7 modules
into inspection. Query errors and incomplete inventories retain unknown ownership;
this isolation does not alter the native environment.

Before first input, launch, receipt, kind, readiness, binding and the complete
original process chain must agree. Official Codex and Copilot integration can
report a new Session only after the first input triggers SessionStart. A durable
single-submission fence therefore precedes that input; successful startup also
requires the subsequent official same-pane Session report and original-process
verification. Unknown input or missing Session evidence never permits replay or
a replacement conversation.

macOS retains per-run daemons. Linux and Windows retain shared daemons with a
durable switch journal and serialized admission. A new target waits for all old
responsibilities and both endpoints to close. Original-claim recovery may recreate
only its original frozen daemon after every old process tree is confirmed stopped.
Attach uses the original Herdr client recipe. Legacy endpoints remain usable for
existing operations, while missing historical recipes cannot authorize new spawn.

This extends the [frozen runtime decision](2026-11-12-worker-frozen-tool-runtime.md),
whose initial delivery kept Herdr automatic until its distinct shell and instance
ownership could be established. It consumes the same
[resolver](2026-11-11-worker-tool-path-resolution.md) without broadening loader
recognition or changing upstream Herdr.

## Alternatives

**Add an executable RPC or modify Herdr.** This would require an upstream protocol
and release change. The existing kind and layout interfaces provide the required
launch mechanism while preserving the original argv checks.

**Replace the audit shell or start a nested persistent PowerShell.** Replacing
the shell loses its birth identity; a nested shell prevents Herdr from seeing an
idle root suitable for agent startup. Root preparation keeps the expected topology.

**Require a new Session ID before any input.** Official integration for the
verified Codex and Copilot releases does not supply that ID at the initial idle
prompt. Waiting there cannot reach the first input. The ordered proof and durable
input fence retain identity protection without manufacturing an integration event.

**Switch all platforms by draining one shared daemon.** macOS already isolates
each run and can start a new execution with a different tool while old executions
remain healthy. Shared drain is needed only for the shared-instance topology.

**Refresh recipes or helper paths during recovery.** This can use a different
installation under the same claim and native Session. Recovery retains original
metadata and fails if a required original dependency cannot be verified.

## Consequences

Tool observations can distinguish the latest target from multiple retained running
selections. Unknown startup, stopping, input and process facts remain explicit
responsibilities, which may delay new shared-instance admission. Retaining those
records costs disk space and requires conservative cleanup across generations.

Private mapping files and process proofs add a separate evidence path alongside
macOS lifecycle records; neither substitutes for the other's input or stop rules.
Three operating-system CI jobs exercise official binaries, root shells, terminal
ownership, official Session reporting and independent cleanup. These isolated
native checks do not establish authenticated Provider or complete Worker behavior.
PowerShell 7 is not part of the supported mapping path.
