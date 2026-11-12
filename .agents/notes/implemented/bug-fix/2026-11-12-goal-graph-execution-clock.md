# Agent Note: Goal graph execution clock

Status: implemented

## Problem

A Goal dependency graph can contain running or completed tasks with known
execution intervals, including direct external prerequisites. Opening that graph
must display their timing without making the Goal page fail to render.

## Decision

`GoalDetailSurface` supplies `TaskExecutionClockProvider` around its existing
chain-dialog branch once the complete project snapshot is available. The context
reaches every graph node through the React portal and uses the snapshot's server
sample, monotonic receipt and project warning threshold. The provider mounts with
the graph and retains its store across snapshots of the same project.

The rest of the Goal content keeps its existing mounting boundary. The timing
hook still rejects a timed task without its provider, exposing missing assembly
rather than substituting a local clock or suppressing timing. The
[execution timing design](../../../../docs/design/daynight-task-timing.md)
owns the clock and subscription rules.

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
the graph releases its timer and visibility subscriptions. Regression coverage
uses real Goal surfaces with non-null execution timestamps instead of adding a
provider in the test wrapper, so it can detect this assembly failure.
