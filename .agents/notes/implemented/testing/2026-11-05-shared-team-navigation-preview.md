# Agent Note: Shared Team Navigation Preview

Status: implemented

## Problem

Team preference, management and member browser checks exercise the same compiled
application through a static Vite preview. Their original independent Playwright
configurations built that application three times and restarted its preview
twice. The repeated preparation delayed the Web browser shard even though
browser contexts and controlled API fixtures were already isolated.

## Decision

`tests/navigation/team-playwright.config.ts` owns one Vite build and preview for
the Team and Session layout projects. `team-preference` groups Team selection and
Worker configuration identity/arrow/save-bar files; `team-management` and
`team-members` own their respective files. `session-record-layout` groups Session
record and Test Session layout files. The original shared-preview grouping had
79 cases across four files; the complete configuration now contains 136 cases.
Each case owns its context, page, controlled API routes and mutable fixture state.
The server serves static assets and holds no account, Team, request or browser
storage state.

The unfiltered local command runs the complete configuration. Browser CI shard 2
passes `--grep @routine` and runs 20 representative cases, under the
[single-target coverage decision](2026-11-06-single-target-web-acceptance.md).
The selection includes two Session layout, three Worker configuration, seven Team
preference, three Team management and five Team membership cases. Tags select
cases before execution without changing their bodies. Full Vitest/V8 state and
route matrices remain required.
The omitted browser combinations remain available through the unfiltered local
configuration and are an explicit reduction in routine browser coverage.

Both selected and complete runs use one worker, zero retries, the default English
locale and desktop viewport with case-owned overrides, and screenshots on failure.
Project-specific output directories remain separate. Members retain failure
traces owned by the [member evidence decision](2026-11-05-team-members-browser-evidence.md).
Preference, Worker and Session cases use 45-second deadlines; management and
member cases retain 30 seconds. Preview startup keeps its 90-second limit, strict
port 4194 and refusal to reuse an existing server. A new run owns and stops its
preview.

The CI navigation branch invokes the shared configuration once, after all 28
editor navigation cases and before the two selected Bot viewport cases. It
retains the 540-second aggregate command budget originally formed from three
180-second commands. Each case still enforces its own deadline. A case failure
makes the command fail after Playwright settles its work; failure or cancellation
prevents later navigation commands and cancels overlapping container work through
the existing callback controller. Both branches drain before combined-auth restart
or dev-ci network cleanup. The outer job keeps its existing bound and gates.

## Alternatives

**Keep three separate previews.** Each group owns a server lifetime, but repeated
builds and startups provide no additional server-state isolation because the
server has no mutable fixture state.

**Overlap all preparation.** Concurrent builds and browser work change resource
competition and can overlap Docker networking changes. The shared static preview
does not require that larger scheduling change; navigation starts after the
production deployment is ready.

**Use one inherited default for every case or output directory.** A combined
configuration without project-owned settings changes case budgets or artifact
locations. Explicit projects retain those differences while sharing the server.

**Keep every browser combination in routine CI.** The full configuration remains
valuable for targeted investigation, but repeats state/route proofs already
covered by Vitest and multiplies layout dimensions. The routine selection accepts
less browser boundary coverage, separately from the original setup optimization.

## Consequences

Sharing the preview removes two original preparation lifetimes. That result did
not rely on reducing the original case inventory, cached results, retries or
longer deadlines. The later routine selection deliberately reduces browser work;
its savings must be reported with the omitted combinations rather than described
as equivalent proof.

Fixture state must remain local to each context and route set. Mutable server
state would require reconsidering preview sharing. The combined deadline still
allows one group to consume time left by another. Navigation overlaps container
functional validation, so reduced navigation duration is not an equal whole-job
speedup; measurements must retain both branch and complete-job boundaries.
