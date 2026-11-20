# Agent Note: Review Git Environment Readback

Status: implemented

## Problem

The Review Git environment test launched a Node process alongside each Git
command to read the same four TLS and Git configuration variables. The check
covered both authenticated and local Git commands, but repeated native process
startup accounted for avoidable test work. The case took 5.407 seconds in the
[November 18 macOS job](https://github.com/codetreker/daynight/actions/runs/44321424045/job/134861785790).

## Decision

The [Review Git environment test](../../../../packages/daynight/test/commands/review/worktrees-environment.test.ts)
checks the four effective values at each command invocation, including the
Windows rules for selecting between spellings of the same key. Two native
readbacks exercise environment delivery through the actual command executor:
one with authenticated clone options and one with local Git inspection
options. Repository and worktree preparation still run with real Git.

## Alternatives

**Read back every native command.** The extra process for each invocation
would repeatedly exercise the same environment assembly in the executor.

**Check only executor inputs.** Inspecting overrides and inherited values
would leave native environment delivery unverified on supported platforms.

## Consequences

The test pays for two readback launches and reports incorrect environment
values for any command invocation. Both native readbacks must observe the
exact configured values, and the test checks that they use different Git
authentication paths.
