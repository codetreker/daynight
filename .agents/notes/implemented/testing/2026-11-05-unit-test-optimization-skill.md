# Agent Note: Unit Test Optimization Skill

Status: implemented

## Problem

A faster test run can hide weakened assertions, missing boundary scenarios, or
shared state. Fast local execution can also conceal the resource contention and
long-running jobs that determine CI feedback time. Optimization needs evidence
about both the cost removed and the incorrect behavior still detected.

## Decision

The repository provides the standalone
[optimize-unit-tests skill](../../../skills/optimize-unit-tests/SKILL.md).
It keeps optimization decisions tied to measured costs and preserved test
behavior, including long waits, polling, isolation, and failure paths. CI
completion time and unusually long jobs or tests influence prioritization.

CI case investigation and optimization use local resource-limited Docker
verification. Container measurements remain distinct from hosted CI results and
required native-platform checks. Task-owned Docker resources are tracked from
setup through verified cleanup, including failed or interrupted runs.

The skill owns the reusable workflow without depending on Daynight or a specific
test framework. Concrete timer and assertion mechanisms remain documented in
their [CLI time and byte](2026-11-04-cli-test-time-and-bytes.md) and
[coordinator polling](2026-11-04-coordinator-test-polling.md) decisions.

## Alternatives

**A universal benchmark helper and framework reference bundle.** These could
reduce repeated measurement work, but command execution, instrumentation, caches,
and synchronization differ across projects. No repeated operation yet warrants
a maintained adapter. The entrypoint leaves tool selection with the project, so
adding a justified helper or reference later is additive and does not require
replacing the workflow.

## Consequences

The skill is discoverable through the repository skill directory and README.
It preserves each request's edit scope and existing validation gates rather
than granting broader configuration, production, or delivery permission.

Reliable CI investigation requires suitable Docker execution and cleanup;
missing resource enforcement remains a validation gap. Model scenario checks
and metadata validation provide separate evidence and do not establish universal
compliance or actual CI performance gains.
