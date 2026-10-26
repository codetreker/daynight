# Windows CI Performance

## Scope and measurement

The baseline is main revision `8a8f3c41ccec94783141cc05e9a42d3b39d2e658`.
Measurements use completed successful GitHub Actions runs, step timestamps from
the jobs API and per-file durations from Vitest logs. Job time excludes queue
delay; it includes runner setup, post steps and inter-step gaps. All table values
are seconds. Separate runs have different runner load, so historical variation
is included rather than treating one measurement as a stable benchmark.

## Baseline

| Run | Platform | Job | Dependency install | Ordinary tests | Installed acceptance |
|---|---|---:|---:|---:|---:|
| [39132420464](https://github.com/codetreker/day-night/actions/runs/39132420464) | Windows | 281 | 5 | 201 | 37 |
| 39132420464 | Linux | 65 | 3 | 27 | 14 |
| 39132420464 | macOS | 91 | 3 | 50 | 18 |
| [39132068273](https://github.com/codetreker/day-night/actions/runs/39132068273) | Windows | 189 | 4 | 129 | 26 |
| 39132068273 | Linux | 52 | 2 | 24 | 12 |
| 39132068273 | macOS | 109 | 4 | 60 | 23 |
| [39131014417](https://github.com/codetreker/day-night/actions/runs/39131014417) | Windows | 264 | 5 | 187 | 36 |
| 39131014417 | Linux | 52 | 3 | 22 | 12 |
| 39131014417 | macOS | 98 | 6 | 52 | 17 |

The first run is the baseline main push. The other two are earlier revisions
of the stale-lock repair, used to check whether the Windows timing pattern
persists across successful runs, not as identical-workload comparisons.

The [baseline Windows job](https://github.com/codetreker/day-night/actions/runs/39132420464/job/117690121799)
reported `git.test.ts` at 196.409 seconds and the entire ordinary Vitest run at
196.94 seconds. Its 48 expanded Git cases summed to 196.406 seconds. The next
largest ordinary files were version checks at 25.215 seconds and coordinator
tests at 13.217 seconds. Installed acceptance took 31.919 seconds inside its
37-second step. The same Git file took 24.235 seconds on Linux and 46.049 on
macOS. Earlier Windows runs reported 126.561 and 181.836 seconds for that file.

## Cause and implementation

The initial fixture starts eleven native Git commands before each case reaches
the manager: one initialization, four object-writing commands for each of two
commits, and two ref updates. Native Git operations also occur throughout the
cases themselves. The observed Windows cost is spread across these cases;
there is no single timeout explaining the file duration.

All 48 cases originally occupied one file. Vitest runs files across isolated
workers by default while cases within a file run sequentially, as documented in
its [parallelism guide](https://vitest.dev/guide/parallelism.html). Independent
files expose this work to the existing scheduler. A per-file immutable bare
seed avoids reconstructing identical starting objects for each case, while
fresh copies preserve separate mutable origins and all real manager operations.
Every platform retains its existing worker defaults. Vitest 5.0.5's
[worker default](https://github.com/vitest-dev/vitest/blob/7a825db43e2beca0b219d2eadaec334cb81af0c7/packages/vitest/src/utils/workers.ts#L3)
reserves one available CPU; the measured Windows split run used three workers.
The [decision note](../../.agents/notes/archived/testing/2026-10-18-parallel-git-validation.md)
records the fixture ownership choices and the alternatives considered.

## Hosted comparison

The first optimized revision `eac0970c55b9dc17baf3e83212ee55ea6466edb0`
split the files and reused seeds while retaining default worker counts.
[Run 39135759769](https://github.com/codetreker/day-night/actions/runs/39135759769)
passed all platforms and the final gate:

| Platform | Job | Ordinary test step | Installed acceptance |
|---|---:|---:|---:|
| Windows | 195 | 115 | 36 |
| Linux | 50 | 17 | 13 |
| macOS | 90 | 47 | 18 |

Relative to the exact main baseline, this Windows run reduced the ordinary test
step by 42.8% and the whole job by 30.6%. Its Vitest portion took 110.67 seconds.
File completion timestamps minus reported file durations establish at most
three overlapping test files. Their summed duration was 299.181 seconds; the
last sparse-primary file started about 83 seconds after Vitest began. Individual
file times include concurrent resource contention and cannot be compared to
the former single file as isolated speed measurements.

## Rejected worker-count experiment

Revision `0f83e217a859000726ade83970fc321f044f9282` set six workers only for
ordinary Windows tests. The
[native experiment](https://github.com/codetreker/day-night/actions/runs/39136340958/job/117701497971)
took 125 seconds for the test step and 120.15 seconds inside Vitest, compared
with 115 and 110.67 seconds with defaults. Four `check-version.test.ts` cases
exceeded the existing five-second timeout: semantic prerelease precedence,
base-only changes, a target-consumed version, and invalid/missing objects or
manifests. The other 471 cases passed and nine platform cases skipped.

This is a failed experiment, not a complete acceptance receipt: installed
acceptance was skipped after the ordinary-test failure. At six workers, the version-check file increased from 31.929 to 75.398
seconds, while ownership scenarios increased from 54.037 to 104.141 seconds.
These widespread slowdowns support resource contention as an inference; CPU
and disk counters were not collected. Wall time did not improve. The final
workflow restores the default worker limit; assertions and timeouts remain
unchanged. The failed run is retained without rerunning it unchanged. Different
host load prevents attributing every duration difference solely to worker count,
but the experiment supplies no basis for shipping that override.

## Validation boundaries

The unchanged local Linux baseline passed type checking and 476 ordinary tests,
with eight platform-specific APFS skips, in a 15.63-second Vitest run. The final
local split suite passed the same 476 tests and eight skips in 4.26 seconds.
Type checking and the 24-scenario installed acceptance also passed. Independent
comparison preserved all 48 expanded Git names, assertion callbacks, six sparse
modes and both cleanup outcomes. A native isolation probe changed a copied
origin's ref and object bytes, verified sibling and seed objects with `cat-file`,
and confirmed separate file identities and cleanup.

The first hosted split-suite Windows run retained its 475 passes and nine
platform skips, and installed acceptance passed on all three platforms. Hosted
checks, rather than local timings, establish Windows behavior. Type checking,
package build, version checks, artifact capture, acceptance scenarios and timeout
limits retain their existing rules. Single-run comparisons are observations,
not a fixed performance guarantee across runner load and toolchain changes.

This report concerns controlled native validation. Live Copilot reasoning and
GitHub publication require separate authorized service acceptance; see the
[validation boundaries](../../README.md#validation).
