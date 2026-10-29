# Agent Note: Native macOS Web Acceptance

Status: implemented

## Problem

The shared Web acceptance pipeline used Linux procfs directly. Docker Desktop
could run the production containers on macOS, but that did not provide native
process recovery, Chromium bundle ownership or case-sensitive attachment storage.
The [pipeline decision](../../archived/testing/2026-10-21-web-acceptance-pipeline.md) established complete
functional and capacity evidence and cancellation ordering; those guarantees must
survive the platform extension.

## Decision

Keep the same target execution capabilities for Linux and macOS. The default
complete `all` pipeline retains the same functional and capacity
inventories, combined authentication checks, four fixed capacity datasets, five
measurements and existing latency limits. Linux remains
the full CI platform; macOS local acceptance requires native execution and does
not imply a macOS CI job.
The [bounded-line rendering decision](../bug-fix/2026-10-22-bounded-dashed-dependency-lines.md)
owns the GPU paint correction needed to retain those capacity budgets on macOS.

Process identity includes the host platform, PID, actual executable, process
group and exact kernel start identity. Linux retains procfs; macOS compiles a
small Apple SDK helper into project temporary storage and reads libproc/sysctl.
Argument matching uses the native argv entries whenever their boundaries remain
available, preserving spaces. Chromium can replace that argument memory with a
single process title. Its pinned
[title builder](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/base/process/set_process_title.cc#49)
constructs one space-separated string; the
[concatenation and publication](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/base/process/set_process_title.cc#96)
use `title += " "`, append each argument, then call `setproctitle`. Thus a procfs
argument read can expose one title even though it remains the source of kernel
process identity.

Browser profile extraction keeps multi-entry native argv canonical, including
arguments containing spaces. Every singleton goes through a strict title grammar:
one unquoted executable token followed by unquoted switch tokens, with exactly
one complete `--user-data-dir=` value followed by another switch. That profile's
parent must be the known managed temporary root and its basename must exactly
match Playwright's generated name with a six-character alphanumeric suffix.
This does not reconstruct general argument boundaries. Duplicate markers,
quotes, backslashes, whitespace inside flattened argument values, foreign roots,
truncated names or any ambiguous match fail explicitly. A discovered
profile still requires the same owned-directory and marker checks; PID, actual
executable, exact kernel start identity, process group, repeated `sameProcess`
verification and companion ownership remain mandatory.

Process discovery filters exact run environment markers without exporting
unrelated process environments. Chromium inventory includes verified macOS bundle
helpers and Crashpad.
The native inspector requests zombie status explicitly: macOS can report an
exited child as present to signal probes while excluding it from the default
BSD identity query. It also rechecks that status when executable lookup races
with exit. Argument inspection can return `EINVAL` after an exiting task loses
its argument memory but before BSD publishes its zombie state. Only that error
with the kernel's `INEXIT` flag permits up to ten 10ms waits, rechecking PID,
exact start identity and process group each time. Only confirmed disappearance
or zombie status counts as absent; an unfinished exit, permission error or
changed identity still fails.

Storage preparation owns an exclusive control directory. The original policy
automatically used an APFS image on insensitive Mac filesystems so that every
native run satisfied the then-required case-sensitive storage contract. The
[native development coverage decision](2026-10-23-native-development-filesystem-coverage.md)
replaces that default: normal Mac runs use ordinary directories and record their
actual capability; `web:acceptance:apfs` explicitly requests an owned
case-sensitive APFS sparse image when necessary. Atomic local receipts and parent persistence
precede attachment. Attachment directly invokes the image command; its help
command also initializes StorageKit authorization and can block before printing
usage. Only the exact unsupported-image-verb error permits the older hdiutil
fallback; permission failures and timeouts do not trigger another attachment.
Cleanup verifies directory/image identity and mount topology,
requires the native service to stop, and detaches before recursive removal.
Explicit busy failures retry at one-second intervals within a shared 30-second
deadline, revalidating ownership each time. A separate three-attempt limit would
end cleanup after about two seconds even when most of the deadline remained;
transient volume users can outlast that window. Cleanup never forces detachment.
Unknown ownership remains an explicit recovery failure. Routine Web tests do not
attach images on macOS: receipt tests run without authorization, while an explicit
native storage suite shares one mounted image across cases. Explicit APFS
acceptance owns at most one native storage image per run. Routine development
and acceptance do not attach images; the diagnostic channel preserves native
filesystem coverage when it is deliberately requested.
The native suite verifies busy recovery with a real acknowledged read-only file
holder. Only a real detach refusal followed by a PID-specific open-file check,
acknowledged release and successful retry establishes that lifecycle evidence.

The platform extension introduced schema 3 to preserve native identity units.
Current top-level evidence and recovery use explicit schema 4 scopes under the
[target execution decision](2026-10-28-web-target-acceptance.md). Older schemas and
cross-platform process identities are rejected; interpretation never guesses
identity units or drops ownership checks. Capacity and container-permission
child formats retain their own versions.

The shared dev-ci runner supports macOS system Bash 3.2. Bootstrap logging uses
an owned FIFO and an explicit background logger: dynamically allocated file
descriptors and waiting for process-substitution children are not portable to
that shell. The parent retains command-group cancellation and joins or stops
the logger before removing its pipe, including interrupted reconfiguration.
Directory permission setup uses syntax supported by both BSD and GNU chmod.

Both Compose stacks expose `DAYNIGHT_NPM_REGISTRY` as an opt-in build argument.
The official registry remains the default; host npm configuration does not
implicitly enter container builds.

## Alternatives

**Docker-only acceptance.** Running only in Docker would keep Linux tooling but
leave macOS native development and process cleanup unverified.

**Parsing `ps`.** Its start time would lose subsecond identity, while rendered
command lines would lose argv boundaries.

**Split every command line on whitespace.** A flattened title cannot preserve
arguments containing spaces. Generic splitting would turn an ambiguous title
into apparently canonical arguments and could attribute the wrong profile.
Bounded profile extraction accepts only the generated, delimiter-safe shape.

**Skip profile ownership checks.** PID or a matching executable alone cannot
justify deleting a profile or stopping a process after identity changes. The
existing marker, start, group and directory checks remain required.

**Read launch arguments through CDP with an added automation flag.** That would
change browser launch and observable automation behavior merely to recover an
ownership fact; existing CDP process-identity discovery is unaffected. Recognizing the narrow documented title representation preserves the
existing browser execution path and acceptance meaning.

**Weaker acceptance.** Skipping case-sensitive attachment checks or relaxing
performance limits would change acceptance meaning between development hosts.

**Global prerequisites.** Installing global GNU tools or mounting an untracked
shared volume would add machine state without reliable task ownership and crash
recovery.

## Consequences

macOS needs the Apple SDK/compiler and permission to attach disk images. Failed
or interrupted runs can leave attributable resources for explicit recovery;
ambiguous mounts are not forcibly detached. Native helper and APFS lifecycle
checks add platform-specific maintenance while the runner remains shared.
A flattened title outside the recognized generated-profile shape remains an
explicit preparation or recovery failure because ownership is unproven. That
failure describes the acceptance guard, not browser support in the application;
it does not permit cleanup to guess identity or profile boundaries.
Windows native Web acceptance stays unsupported. A future macOS CI job must
provision these prerequisites and execute the complete gate before claiming CI
parity. The [Web README](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns setup and recovery commands; the [design](../../../../docs/design/daynight-web.md)
owns the pipeline mechanism.
