# Agent Note: Shared Team Navigation Preview

Status: implemented

## Problem

Team preference, management and member browser checks exercise the same compiled
application through the same static Vite preview. Running each group through an
independent Playwright configuration builds that application three times and
restarts its preview twice. The duplicated preparation delays the Web browser
shard even though its browser contexts and API fixtures are already isolated.

## Decision

`tests/navigation/team-playwright.config.ts` owns one Vite build and preview for
three Playwright projects. `team-preference` retains both Team preference and
Worker configuration identity files; `team-management` and `team-members` retain
their respective files. The combined inventory contains the original 79 cases
across four files. Each test still receives its own browser context, page,
controlled API routes and mutable fixture state. The shared server serves static
assets and holds no account, Team, request or browser storage state.

The complete run retains one worker, zero retries, the default English locale
and desktop viewport, per-case overrides, and screenshots on failure. Project-specific output directories remain
unchanged, and members retain failure traces owned by the
[member evidence decision](2026-11-05-team-members-browser-evidence.md). Preference
and Worker identity cases retain 45-second deadlines; management and member cases
retain 30 seconds. Preview startup retains its 90-second limit, strict port 4194
and refusal to reuse an existing server. A new run owns and stops its preview.

Browser CI shard 2 invokes the shared configuration once after editor navigation
and before Bot viewport checks. The command keeps a 540-second aggregate budget,
the sum of the three former 180-second command limits. Cases still enforce their
own original deadlines, while the combined command no longer enforces separate
three-minute group boundaries. Projects remain independent: after a case fails,
other Team cases can finish in their fresh contexts before Playwright returns a
failed command. That failure or cancellation prevents later Bot and full-stack
acceptance work. The outer job retains its 20-minute limit and the final required
checks retain their existing gates.

## Alternatives

**Keep three separate runs.** Each group owns a preview lifetime, but two repeated
builds and preview startups provide no additional server-state isolation because
that server has no mutable test state.

**Overlap the complete browser pipeline.** Running more preparation and browser
work concurrently would alter CPU and memory contention and the ownership of
shared evidence paths. Removing repeated static preparation does not require that
broader scheduling change.

**Use one inherited default for every case or output directory.** A combined
configuration without project-owned settings would change the existing case
budgets or failure-artifact locations. Explicit projects retain those differences
while sharing only the static server.

## Consequences

The three groups pay for one static application build and preview startup. This
removes two preparation lifetimes without relying on skipped tests, cached test
results, extra retries or longer case deadlines. The actual command and CI savings
depend on build cost and runner variation; removing preparation is not proof of
a particular whole-job speedup.

Fixture state must remain local to each test's browser context and API routes.
Introducing mutable server state would require reviewing whether the preview
can still be shared. The command's combined deadline preserves its former total
budget, so individual groups can consume time that another group leaves unused;
performance measurements must identify that budget composition separately from
preparation savings.
