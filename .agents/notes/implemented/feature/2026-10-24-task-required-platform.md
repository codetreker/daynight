# Agent Note: Task Execution Platform Requirements

Status: implemented

## Problem

Tasks in one repository can require different operating systems. Readiness and
permission for automatic execution do not express that requirement. A bounded
candidate page can also appear empty after local filtering even when a later
compatible task exists. Platform edits must remain consistent with task versions,
manual execution and in-flight browser writes.

## Decision

The [three-state setter](../architecture/2026-10-24-task-status-assignment.md) owns
current task state changes; platform migration013 remains unchanged and precedes
status migration014. Platform selection remains independent of task state.

Tasks and graph nodes expose the required nullable `requiredPlatform` field:
null means unrestricted; `windows`, `linux` and `macos` require that platform.
A nullable database column and migration give existing tasks null while
preserving their other fields, versions and timestamps. Creation accepts an
optional enum or null. PATCH distinguishes omission, an enum value and explicit
null as preserve, set and clear. Strict readers reject missing or invalid values.

Platform edits use the existing member-authorized project transaction and exact
version check. Same-value requests preserve version and update time, while stale
requests still conflict. Actual changes during `in_progress` fail atomically,
including when combined with other edits. Status and metadata writes preserve
the platform and [automatic-execution permission](../architecture/2026-10-23-task-agent-automation.md)
independently. Explicit manual status setting does not enforce automatic-worker platform
eligibility, and a platform mismatch does not change ready or task statistics.

The shared platform domain owns enum validation and compatibility. List queries
accept `compatiblePlatform` and include unrestricted tasks plus requirements
matching the requested enum. Platform, permission, readiness and status filters
run before ordering, pagination and lookahead, with every condition bound into
cursor scope. CLI list and bounded ready pass `--compatible-platform` through to
the server and validate returned items without filtering away a page locally.
The bundled automatic workflow determines its actual execution runtime from
`process.platform`: win32 maps to windows, darwin to macos and linux to linux,
including WSL. Unknown or unsupported platforms wait rather than infer a value
from task requirements, configuration or an outer host. Ready and fallback list
queries retain both permission=true and compatibility filters. Before setting in_progress,
the latest full task must still be ready, allow automatic execution and have a
null or matching requirement; its exact observed version protects that decision.
An automatically selected task ID is not an explicit manual assignment.
Create/update expose `--required-platform`; update's mutually exclusive
`--clear-required-platform` sends null. Human output shows any for null and the
enum for a restriction, while JSON retains the nullable field.

The original Web allocation used a platform badge in the detail status row and
a separate Overview select with an explicit Save platform action. That separated
choosing from submitting while the platform field, versioned updates and shared
write ownership were introduced. The [confirmed platform control decision](../simplification/2026-10-24-task-platform-confirmation-control.md)
supersedes that UI allocation: one status-row select now displays the confirmed
requirement and opens confirmation for a different value. List and graph badges
remain read-only. This note continues to own the nullable field, domain and query
decisions; their authorization, no-op, status and reconciliation guarantees
are unchanged. The [Web architecture](../../../../docs/design/daynight-web.md#平台要求与确认下拉框)
owns the current component and request behavior.

## Alternatives

**Filtering a bounded candidate page locally.** Earlier incompatible tasks can
consume the complete page and hide later compatible work. Filtering must precede
the server's ordering and page boundary; clients reject a response that violates
its declared filter rather than silently dropping items.

**One nullable PATCH value without field presence.** A nullable pointer alone
cannot distinguish omitted input from explicit null. Keeping field presence
separate makes metadata edits preserve a requirement while clear remains an
intentional operation, without extra endpoints or sentinel strings.

**Coupling platform delivery to worker startup.** Requiring a worker-specific
claim endpoint or agent startup to deliver the task field would reverse the
worker design's prerequisite order. The delivered domain predicate and candidate
query are reused by the [claim foundation](../architecture/2026-10-24-worker-claim-foundation.md).
The bundled workflow already uses its actual execution platform; daemon-specific
environment integration, resource startup and execution history remain with the
[worker architecture](../../../../docs/design/daynight-worker.md).

## Consequences

A task's saved requirement is explicit across service, CLI and Web, without
inventing a default in readers or inferring an execution environment from the
server. A query platform is a selection argument, not a configuration override
or proof of where a process runs. The bundled automatic workflow binds its
selection to the observed runtime and rechecks eligibility before versioned set-status in_progress. The future worker daemon must likewise use its actual runtime, including
Linux for WSL, and recheck compatibility in its claim transaction before starting
resources.

Platform acceptance covers migration preservation, strict input/resource values,
null/set/omitted behavior, the complete compatibility matrix, filter pagination
and cursor scope, versioned no-ops, in-progress locks and ordinary-status races.
Browser behavior retains bilingual controls, keyboard access, narrow layouts,
request ownership and visible errors. These checks establish the platform
contract; native worker startup, recovery and historical execution-platform
claims still need their own source-bound runtime evidence.
