# Agent Note: Goal graph execution clock

Status: implemented

## Problem

A Goal dependency graph can contain running or completed tasks with known
execution intervals, including direct external prerequisites. Opening that graph
must display their timing without making the Goal page fail to render.

## Decision

The original fix supplied `TaskExecutionClockProvider` around the Goal chain
dialog after a complete project snapshot arrived. The portal inherited its
context and the timed-task hook exposed missing assembly instead of inventing a
clock.

The [shared completion clock](../architecture/2026-11-12-shared-completion-clock.md)
now moves that ownership to stable project and standalone resource page roots,
covering the Goal graph and its siblings without remounting content on the first
snapshot. The [execution timing design](../../../../docs/design/daynight-task-timing.md)
owns the current clock and subscription rules.

## Alternatives

**Rely on the project task workspace.** The Goal dialog is its sibling and the
standalone Goal page has no such ancestor, so that context cannot cover either
Goal graph entry point.

**Conditionally wrap all Goal content when a snapshot arrives.** Changing that
ancestor can remount drafts, attachments and reading state that do not depend on
the graph clock. The existing graph branch already has the required snapshot.

**Construct a clock inside the chain dialog.** Its index and summaries do not
contain the complete receipt sample or project settings. Passing another clock
contract or inferring one would duplicate ownership already available in the
Goal surface.

## Consequences

Both Goal entry points display timing for ordinary and external nodes. Closing
the graph removes its subscriptions; the page owns the shared clock. Regression coverage
uses real Goal surfaces with non-null execution timestamps instead of adding a
provider in the test wrapper, so it can detect this assembly failure.
