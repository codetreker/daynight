# Agent Note: Local Development Environment Preparation

Status: implemented

## Problem

A development command can coexist with a healthy local site while both still
refer to old builds. Shell wrappers, Agent aliases, running Workers and installed
skills have different update lifetimes. Configuration-root separation also leaves
repository paths and native accounts shared. Without a reusable operating guide,
an environment refresh can validate the wrong revision or affect resources that
belong to another execution.

Experience audits also need a repeatable path from representative data to a
useful delivery input. Layout geometry can look valid while text is unreadable;
captures from different loading states can appear to support a false finding.
Without explicit evidence and issue boundaries, an audit can produce duplicate
or bundled tasks whose user impact and acceptance conditions are unclear.

## Decision

The repository owns the [prepare-daynight-local skill](../../../skills/prepare-daynight-local/SKILL.md)
and its environment, local test, website and experience-audit references.
It records resource identity before mutation, binds artifacts
to a selected source revision, and distinguishes preparation, installation,
process cutover and Agent command verification. It uses
the existing native/Compose deployment and development installer rather than a
second runtime manager.

The [development CLI architecture](../../archived/architecture/2026-10-29-local-development-cli.md)
records the rationale for the existing snapshots, configuration roots and
private aliases. The skill
adds an operational procedure around those mechanisms without changing their
isolation or lifetime guarantees. An environment resource record stays private
and Git-ignored. Environment preparation does not use Daynight tasks for work
tracking. Complete test-environment preparation creates one bounded localhost
acceptance fixture: the CLI creates it, the website enables it, the development
Worker executes it, and both clients verify its evidence and completion. These
writes are restricted to the selected local test project. Dispatch requires an
exclusive test pool or an effective fixture-specific scheduling restriction;
an online Worker with unrelated selected Projects is not a bounded test runner.

The user selects the GitHub test repository before provisioning. Development
configuration stays at `~/.daynight-dev`, outside the test checkout and separate
from stable state. Incompatible retained state can remain untouched while a
separately identified child root verifies current behavior; that test does not
prove a lossless upgrade. A generated executable router selects development by
physical cwd, sets the root only in that child and delegates outside calls through the
current PATH. Activation checks every routed command before changing PATH, so
managed Agent shims retain their pinned snapshots even when only `dn` is configured.
GitHub provides the checkout; the local fixture requires no remote Git writes.

The website guide connects observable UI actions to CLI readback, distinguishing
permission enablement from task claims and saved Worker configuration from
application. The public setup page's displayed origin does not configure copied
CLI commands. Public navigation and demonstration data can be inspected without
a selected repository, but do not prove authenticated task execution.
Default localhost preparation uses the existing UniAuth fixture and authentication
helpers to establish a test persona, ordinary browser Session and ordinary CLI PAT
without interactive sign-in. Only the external GitHub responses are controlled;
normal identity and project-permission checks remain exercised. The fixture and
test server share the same App registration and exact callback origin.

Browser automation uses the selected browser implementation in an isolated
headless context, defaulting to Edge, so the user's ordinary windows and profiles
remain available.
Actual document focus and authenticated UI requests still require verification.
Real OAuth and device consent remain optional checks with the user's participation;
their ordinary background tabs can pause authenticated requests. Preparing test
credentials does not replace actual UI task operations or prove real OAuth.

The runtime procedure checks WebSocket Upgrade forwarding separately from HTTP
readiness. A private Vite override can enable `ws: true` while preserving
`changeOrigin: false` and the actual browser Origin; serving the embedded UI from
Go is an alternative with the same public origin. Native Provider environment
checks disclose only the selected provider/model, `env_key` and presence of its
value. Restoring the established Worker launch environment preserves the original
claim, execution and native session. A new Controller generation is distinguished
from a new execution, and recovery does not replay confirmed bootstrap input or
retry a failed native turn automatically.

The UI audit starts from a user's intended result and selects representative
data and states for that path. Product principles, WCAG criteria and usability
heuristics guide exploration; observed impact determines whether a candidate
becomes an improvement. It checks responsive geometry and actual interaction,
including failures that cause no horizontal overflow. It also records ruled-out
candidates and untested paths so later iterations can correct false positives
and extend coverage. A screenshot or animation
frame failure reproduced on a blank page belongs to the browser-platform
diagnosis; working pointer actions remain valid evidence. Screen-media PDFs and
DOM geometry are labelled as static evidence, with compositor, animation and real
mobile-keyboard checks kept separate. Each independently actionable improvement
receives its own task after duplicate checking when task registration is in scope.
Prototypes and complete review inputs are task attachments and are read back
before handoff. Local UI fixtures remain separate from production delivery tasks.

Two small local helpers support the fragile parts of this workflow. Evidence
capture checks the explicit loopback origin and semantic readiness, then compares
selected state and geometry before and after capture. It labels inconsistent or
failed attempts and never silently changes screenshot capture into print output.
The finding-package validator checks one package's declared files, supported
attachment links and current byte hashes. Description links resolve from the
task attachment root, independently of the local Markdown source location, and
URL decoding preserves the Web consumer's segment boundaries. It does not judge
issue independence, prototype behavior or publication permission. Production mutations remain in
the canonical CLI handoff, with readback and unknown-outcome reconciliation;
neither helper can create or enable a task.

Each audit's results stay with its private source-bound evidence and owning
delivery tasks. The skill retains transferable methods, fixture categories and
demonstrated failure corrections. After a delivered fix reaches the selected
main revision, a later audit repeats the real failure path and adjacent states;
an implementation report or successful prototype does not close that validation
gap. This separates iterative skill improvement from an expanding log of runs.

## Alternatives

**A single automatic update script.** Existing native services and Compose stacks
have different owners, persistence and cutover requirements. A universal script
would need another state model for process ownership and active executions. The
skill can reuse maintained commands and resolve those choices from observations.

**Only extend the development manual.** The manual already documents individual
mechanisms. A discoverable skill gives an Agent the cross-component sequence and
acceptance boundaries while linking back to the manual for maintained details.

**Put machine paths and credentials in the skill.** This would turn a reusable
workflow into a stale installation snapshot and expose private data. Resource
paths are resolved at use time; only private file locations and credential
presence belong in the environment record.

**Switch configuration roots in an interactive directory hook.** Noninteractive
children can change directories without running the hook, and exported roots can
leak into outside commands. An executable dispatcher checks each invocation and
keeps the parent environment unchanged. Its PATH entry can remain visible outside
the test directory even though it delegates to the ordinary command there.

**Disable authentication on localhost.** Bypassing authentication would omit the
user, project-membership and Worker-ownership behavior needed by the test loop.
The maintained fixture supplies automatic test identity while retaining those
product checks, without adding a production authentication bypass.

**Require an existing interactive browser login for every test.** Reusing a real
account is useful for login acceptance, but foreground identity checks and device
consent require user interaction and prevent unattended background testing.
An owned headless context with a test persona covers ordinary product operations;
real login remains a separate verification layer.

**Treat HTTP readiness as full Web-mode acceptance.** The development proxy can
forward normal API requests while omitting WebSocket Upgrade. Checking the
actual Session connection avoids admitting an environment whose task API works
but whose Controller cannot connect. Both a scoped proxy override and the
embedded server remain supported operating choices.

**Restart an execution from scratch after a launch-environment failure.** A fresh
task or claim would hide the recovery behavior and could duplicate confirmed
input. The existing journal and native identity provide the necessary recovery
boundary; another turn remains an explicit continuation, not an inferred replay.

**Report every capture failure as a UI bug.** Animation-frame and screenshot
operations can fail on a blank page in the same browser. A minimal platform
comparison preserves that distinction while allowing pointer and static-layout
checks to continue. Those alternatives still cannot prove animation or mobile
keyboard behavior.

**Automate discovery and production dispatch in one script.** Whether an unusual
layout harms a user's task, or two observations describe the same problem,
requires contextual judgment. Combining that judgment with credentials and
retrying writes would make uncertain findings easier to publish repeatedly.
The helpers instead automate state sampling and file integrity; the audit and
canonical handoff retain semantic judgment and explicit destination checks.

**Keep every lesson in the skill entrypoint.** Detailed fixture, evidence and
handoff procedures apply at different stages. Focused references make those
procedures available when needed without loading every operating detail for a
simple environment check. Run-specific paths, identifiers and logs are not
reusable guidance and remain outside the skill.

## Consequences

Future runs can prepare and verify a local environment without rewriting the
canonical task-management skill or replacing the npm CLI. The procedure makes
retained snapshots, data migration limits and incomplete verification visible.
It does not add transactional environment upgrades, automatic resource garbage
collection, a new daemon or broader platform support. Behavioral rehearsal and
document validation do not prove a real environment upgrade or Provider run;
those results must be gathered when the skill is executed on its selected target.
An audit can produce bounded implementation inputs without changing product code;
task registration, handoff and completed implementation remain distinct outcomes.
Evidence consistency checks cover only the selected elements and capture window;
they cannot freeze a page or establish complete visual correctness. Package
hashes describe files at validation time, so later edits require revalidation and
uploaded bytes still require readback. Heuristic exploration remains necessary
alongside these deterministic checks.
The private Vite override is not a repository fix, and background browser
acceptance does not certify every browser, device or accessibility criterion.
An incompatible preview migration ledger remains a data-upgrade problem. A clean,
separate test database can verify current behavior without repairing or replacing
that retained preview, and must be reported as a different environment.
