# Agent Note: Worker Attach Command

Status: implemented

## Problem

The worker's private Herdr session is outside ordinary `herdr session list`
discovery. Opening it by hand requires the correct configuration, XDG paths,
shell-history setting and removal of inherited session identities. Reconstructing
those settings from a diagnostic descriptor makes routine human input difficult
and can connect a client to the wrong instance.

## Decision

`daynight worker attach` opens an interactive client for the existing private
worker session. It consumes the attachment descriptor owned by the [Herdr
adapter](../architecture/2026-10-26-worker-herdr-adapter.md), applying its
environment and identity removals only to the client. Private directories,
managed configuration, disabled native auto-restore and original task-pane
environments retain their existing owners.

The command is a local client entry. It requires an interactive terminal and
does not read Daynight credentials, query the service, open worker SQLite or
acquire the worker lock. It connects only to a compatible existing instance;
an absent session produces an error directing the operator to
`daynight worker run`.

The child uses Herdr's direct `client` mode, which [enters the client without
daemon autodetection](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/main.rs#L573-L577).
Unlike ordinary launch dispatch, this mode cannot start a replacement daemon
if the original endpoint disappears between inspection and connection. The
client inherits terminal stdio and has no RPC-operation lifetime deadline.
Detaching leaves the daemon, original agents and claims running. Client launch
and exit failures remain visible; the entry does not stop the server or change
task ownership.

The foreground runtime advertises the attach command after inventory and managed
instance readiness. The [worker guide](../../../../packages/daynight/README.md#worker-configuration-and-startup)
owns operator instructions, and the [worker design](../../../../docs/design/daynight-worker.md#观测关联和错误)
owns the lifecycle details.

## Alternatives

**Move the worker session to the normal Herdr directory.** This would make it
visible to ordinary list and attach commands, but normal named sessions share
Herdr configuration. Native auto-restore could then run before worker ownership
and termination decisions. Keeping the private managed instance preserves the
existing restoration and history policy while the client command supplies the
missing convenient entry.

**Ask operators to apply the printed descriptor manually.** The descriptor is
useful as a structured internal boundary, but manually rebuilding environment
overrides and identity removals is unnecessary work for every connection.

**Use ordinary Herdr launch dispatch after checking the endpoints.** A daemon
can disappear between the check and connection. Ordinary dispatch may start a
new daemon, so a preceding availability check cannot enforce connection-only
behavior. Direct client mode closes that race.

## Consequences

Human input has one command while private instance isolation and the worker's
native recovery authority remain intact. Ordinary `herdr session list` continues
to enumerate its own namespace; the worker command owns access to the private
namespace. A stopped or incompatible instance remains an explicit error rather
than an implicit worker or agent startup.

The direct client entry is a Herdr 0.9.5 source-qualified behavior. Future Herdr
upgrades must preserve its connection-only semantics and terminal behavior;
help/schema checks alone do not establish a successful interactive attachment.
