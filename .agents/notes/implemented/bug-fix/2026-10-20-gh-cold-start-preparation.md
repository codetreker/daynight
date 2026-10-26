# Agent Note: Preparing Native gh Probes Within One Deadline

Status: implemented

## Problem

At the time of this incident, publication required successful mainline checks
for the exact source commit.
The Windows job in [run 39394480855](https://github.com/codetreker/daynight/actions/runs/39394480855/job/118533679906)
failed before tests when native `gh --version` exceeded its 10-second deadline.
The corresponding [publication run](https://github.com/codetreker/daynight/actions/runs/39395114847)
therefore stopped at its source-check gate. Native tool versions and the complete
validation workload remain required. The later
[CLI publication-validation decision](../process/2026-10-22-cli-publication-validation.md)
removes the publication dependency on the full mainline run.

The earlier [probe isolation decision](../../archived/bug-fix/2026-10-19-native-environment-probe-isolation.md)
isolated gh configuration and state, disabled telemetry and preserved failures.
It deliberately left the original startup trigger unresolved. The recurrence
required measurements of first process startup rather than another assumption
about configuration or network access.

## Decision

Before launching a resolved `gh` command, the collector reads the selected file
sequentially using one reusable 1 MiB buffer. It records bytes read, SHA-256 and
preparation duration, then executes the original command, arguments and child
environment. The hash describes the file content observed before execution;
it is not a security identity guarantee or a substitute for native version output.
Existing command resolution, shim handling and gh state isolation remain intact.

Resolution, preparation and native execution share one monotonic 10-second gh
budget. Each read checks the deadline. The child receives the positive integer
remainder after prelaunch diagnostics, and a result obtained beyond the deadline
cannot succeed even when the native exit status is zero. Exhausting the budget
before launch prevents execution. Native errors retain their original objects
and take precedence over a later deadline error.

Preparation failures retain their partial byte count and duration. Diagnostic
states distinguish resolution, preparation, execution and completion; the final
receipt includes native PID and the actual execution timeout. Other tool probes
retain their existing execution limits. Child capture remains bounded to 1 MiB,
with 16 KiB per stream in the diagnostic receipt. Full environment provenance is
written only after every native version succeeds.

Synchronous filesystem and process-creation calls can return after their budget
has elapsed. The deadline guarantees rejection of an over-budget result; it does
not promise that Windows will preempt every blocking system call at exactly ten
seconds. The existing 600-second native CI job bound remains in force.

### Native evidence

All measurements used independent Windows hosts with image `20261007.264.1`,
Node `24.21.0`, pnpm `10.34.5` and gh `2.102.0`. The selected gh executable's
SHA-256 matched the official release binary:
`756724853cc579510b58e65e7a7429ad6b1af29cf99ef19b3a95f3b701c5c580`.

The [cold/warm control run](https://github.com/codetreker/daynight/actions/runs/39399694568)
measured untraced first startup at 2.93-3.44 seconds in the baseline group;
subsequent startup on those hosts took 0.43-0.48 seconds despite initialization
tracing. UTC timezone selection and regular-file output did not eliminate the
first-start cost. A separate six-host PATH experiment showed no stable benefit
from setting `GH_PATH`.

In the [stack and preparation run](https://github.com/codetreker/daynight/actions/runs/39400665999),
two usable debugger snapshots were in Go package initialization, before
`ghcmd.Main`: `charm.land/lipgloss/v2.init` and
`github.com/briandowns/spinner.map.init.0`. These identify a startup phase, not
defects in those packages. The three prepared first launches took 0.54, 0.62 and
2.58 seconds including the read and hash; native execution took 68-136 ms.
Debugger activity perturbed the baseline timing in this run.

The final [untraced ten-host comparison](https://github.com/codetreker/daynight/actions/runs/39402757322)
tested the historical collector and the implemented collector on five fresh
hosts each. Both groups disabled the debugger and initialization tracing, used
the same fixed process observations and retained real native version execution.
Times below include resolution and all preparation, not only the child command:

| Collector | Successful first launches | Median | Range |
|---|---:|---:|---:|
| Historical collector | 5/5 | 3818.19 ms | 3212.19-5947.25 ms |
| Prepared collector | 5/5 | 603.16 ms | 546.40-971.57 ms |

Prepared native execution took 76-103 ms; the actual child timeout was reduced
to 9116-9570 ms after preparation. Every prepared receipt included the matching
42,875,192-byte selected file and official SHA-256. Subsequent launches measured
128.57-204.92 ms for the historical collector and 147.07-216.98 ms for the prepared
collector, exposing the expected extra read cost on warm files. The median first
launch improved by 84.2% within the stricter shared budget. Five samples per arm
establish this observed improvement, not an upper bound on every future host.

Windows [file caching](https://learn.microsoft.com/en-us/windows/win32/fileio/file-caching)
supports the preparation mechanism, but does not guarantee residency of all
executable pages or establish an antivirus cause. The original failed process
has no live stack capture, so its exact operating-system trigger remains unknown.

## Alternatives

**Raise the deadline or retry failed probes.** These would change the accepted
failure condition without reducing cold-start work. Preparation and execution
consume one 10-second total budget, and a failure remains a failure.

**Set `GH_PATH` or force UTC.** These remove real eager discovery work, but the
native comparisons did not establish a useful startup improvement. The captured
Go initialization precedes both operations.

**Capture output in regular files.** This did not remove the cold-start cost and
would require separate output-bound enforcement. The existing pipe capture and
native `maxBuffer` behavior remain in use.

**Use synchronous overlapped stdio.** Node accepts the JavaScript option but its
synchronous native parser aborts on it; [Node issue 48476](https://github.com/nodejs/node/issues/48476)
records this implementation gap. Adopting asynchronous execution solely for that
option would change lifecycle and timing mechanisms without supporting evidence.

**Read version metadata without native execution.** File preparation establishes
neither a successful launch nor a valid native response. Version output remains
mandatory.

## Consequences

The preparation stage makes selected-file provenance and cold-start cost
observable while keeping the total gh budget strict. Regression checks cover
complete sequential reads, bounded buffer reuse, preparation failure and
deadline exhaustion, positive remaining timeouts, over-budget native success,
original native errors, and child-environment isolation.

The additional read is deliberate I/O and may have little benefit on a warm or
non-Windows host. A selected shim's hash describes the shim, not every program
it later invokes. Files can also change after preparation under the preexisting
command-execution model. Those limitations do not replace native execution or
relax failure propagation.

The temporary tracing, debugger and transport experiments are diagnostic work;
ordinary CI retains its original platform matrix, workload and artifact owners.
