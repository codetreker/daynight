# Agent Note: Compatibility Worker process boundary

Status: implemented

## Problem

Compatibility runs exercise historical Workers and Controllers whose local
shutdown records and process behavior may differ from the current client. A
Worker process group can finish while a detached Controller or Git descendant
remains, so that group's exit alone does not establish that fixture credentials
and services are no longer in use. A failed Worker must remain a failed
compatibility observation even when cleanup succeeds.

## Decision

The [compatibility matrix](2026-11-24-ordinary-subtask-compatibility.md) runs each
Worker in a dedicated, digest-pinned Node and Git container with a private PID
namespace. The checkout is mounted read-only at the same absolute path, and the
fixture directory is writable. Host networking provides access to the existing
loopback gateway. The isolated Worker owns its spawned Controllers, peers and Git
commands within that process boundary. Fixture setup commands outside the
container retain their existing tracked process ownership.

The fixture durably records the run and Worker identities, container ID, image,
mutation phase and observed exit. It verifies those identities before cleanup.
The fixture records bounded, token-redacted diagnostics and distinguishes a
nonzero Worker exit from successful termination of the container. It stops and
observes the container before releasing fixture data or services. On interrupted
creation or startup, an observed matching container reconciles the original
operation; an absent or still-indeterminate observation does not authorize a
replay or cleanup. An explicit invalid bind refusal followed by an absent
container establishes that creation did not succeed. A stopped container and
an explicit removal permission refusal allow a later removal attempt. Other
unresolved removal outcomes retain the fixture. A tracked Docker signal gate
allows recovery to join the original client and terminate a stuck container.

Worker Task reads retry bounded, explicitly recoverable partial Session
observations. They validate the Task and original Worker and claim identities
before using a complete observation; the last partial reason, error and
freshness remain available on failure. Mutations are never retried by this
reader.

## Alternatives

**Use only process groups and Controller records.** The current records can
prove the descendants they identify, but an interrupted historical Worker can
leave no complete record for an independently detached process.

**Run the whole matrix inside a container.** The runner currently owns Docker
service cleanup while it is alive; an outer owner would need a separate cleanup
stage after the entire runner boundary stops.

**Accept partial Task reads as complete.** The Task data may survive a partial
Session observation, but treating it as complete conceals an unavailable or
changing execution and could allow later assertions to use the wrong claim.

## Consequences

The container supplies a common process lifetime for old and current clients,
including failure paths; the Worker result still determines whether the scenario
passed. Host networking is used only for the existing local gateway and is not a
separate network isolation claim. The fixed image adds a preparation dependency.
An unresolved Docker mutation retains the original fixture and prevents service
cleanup until its outcome can be observed. Historical runs without this boundary
cannot acquire a retroactive stop proof.
