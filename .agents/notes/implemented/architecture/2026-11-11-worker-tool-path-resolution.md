# Agent Note: Shared Worker tool path resolution

Status: implemented

## Problem

A machine can contain several Codex, Copilot or Herdr installations. A bare tool
name or an unstructured configuration string cannot describe whether the user
selected automatic discovery or one particular installation. Trimming a path,
expanding shell expressions or interpreting embedded spaces as arguments can
change the requested file. A script path also leaves its interpreter and any
package-selected native executable unspecified, so hashing only the entry cannot
detect replacement of the actual tool. Ambient Node module search and symlink
modes can change a loader's selected native without changing its bytes. Adding a
local setting directly to the existing cloud payload would break clients and
services that reject unknown fields.

## Decision

The platform-owned `tool-path-choice.ts` defines complete local choices for
Codex, Copilot and Herdr. Both Worker configuration readers use the same parser.
An omitted mapping, omitted tool or per-tool null produces `kind: auto`; a path
produces `kind: path` with its exact string. The parser rejects unsupported keys,
empty values, non-absolute paths, control characters, malformed Unicode and
values exceeding 4096 UTF-8 bytes. Windows paths must identify a drive or UNC
share rather than relying on the current drive.

Path parsing has no filesystem or process side effects. The shared
`tool-executables.ts` resolver turns a choice into a complete launch recipe while
remaining independent of Worker scheduling and Provider implementations.
Automatic choices preserve the tool/context distinction: Codex and Herdr use the
captured PATH, Web Copilot uses the bundled native runtime, and Herdr Copilot uses
the captured PATH. Explicit resolution uses only the selected installation.

Node entries use the fixed Worker Node executable. npm shims are unpacked by
extracting a target from one bounded byte snapshot without executing shell text.
Suffix matching is case-insensitive without rewriting the selected pathname. The
pathname-only `read-cmd-shim` API would reopen the file outside these bounds and
dispatch uppercase `.CMD` names to the wrong parser. Official Copilot entry
resolution uses the native package belonging to that installation. Codex Node
entries run as ordinary scripts and select their own native program. The
[launcher admission decision](2026-11-12-worker-launcher-admission.md) replaces
the original complete-template and Codex loader registration rules.

Both metadata reads and artifact hashes open POSIX files with `O_NONBLOCK` before
checking the opened descriptor's regular-file type. A pathname precheck cannot
prevent replacement with a FIFO before open, and an operation timeout cannot
cancel a blocking kernel open or free its filesystem worker. Descriptor checks
and bounded close retain ownership on errors and cancellation; supported symlink
mapping checks remain independent.

Streaming hashes and mapping checks cover the recorded entry, wrappers,
interpreter and selected artifacts. Verification checks the frozen command,
selection key and artifacts without consulting new configuration or PATH.
`selectionKey` retains lexical artifact paths so changed symlink mappings remain
detectable. A separate `probeResourceKey` removes lexical aliases and selection-only
PATH/PATHEXT while retaining canonical content, cwd and other native environment
isolation. Two aliases for the same program can therefore share a probe cleanup
owner without losing their distinct entry-verification obligations. Windows search
keys are normalized before exclusion. POSIX environment names remain case-sensitive,
so a native variable such as `Path` still isolates probes.

A bounded process-local digest cache avoids repeatedly streaming large Node and
native executables. Its 128 entries require the same canonical path and complete
device, inode, mode, size, nanosecond mtime and ctime signature. Cache hits still
open the file and verify its type, handle and path signatures, realpath and any
parsed-content digest. Only stable observations populate the cache; a same-size
rewrite with restored mtime still invalidates it through ctime.

Local choices do not have a cloud adoption state. The independently negotiated
[cloud configuration](2026-11-11-worker-tool-path-configuration.md) owns nullable
adoption, bootstrap and legacy projections. The
[Worker specification](../../../../docs/spec/daynight-worker.md#本地工具路径解析)
owns the accepted local values; the
[Worker design](../../../../docs/design/daynight-worker.md#本地工具路径选择)
owns parser responsibilities and the current integration boundary.

## Alternatives

**Represent automatic discovery as an empty string.** Empty and whitespace-only
input cannot distinguish an intentional reset from an incomplete path. Explicit
null or omission keeps reset semantics separate from invalid text.

**Normalize or expand paths in the configuration layer.** This would lose the
user's lexical entry, make shell-like text active, or silently resolve a path
against the current directory. Validation preserves the whole input, and the
executable resolver owns physical resolution.

**Import local paths through the current cloud bootstrap.** The current wire
format does not negotiate tool paths. Extending it here would break strict
parsers and conflate local parsing with cloud adoption. Protocol support needs
its own capability and persistence rules.

**Execute arbitrary wrapper scripts or infer a Node beside an nvm CLI.** A
wrapper can run extra commands or choose another installation, and its location
does not prove an interpreter choice. The original design used complete known templates and a fixed Worker Node
to make the launch recipe explicit. The replacement extracts only the target as
data and retains the fixed Worker Node; it does not execute wrapper text.

**Fingerprint only the entry or use its selection key as a probe lock.** An
unchanged official loader can start a replaced native binary. Lexically distinct
symlinks can also name the same program and bypass a lock keyed by entry spelling.
The original static model recorded the selected native alongside the loader; a
separate canonical resource key addressed probe ownership. The replacement retains
recorded artifact verification and the resource key, but does not infer a Codex
native dependency from loader bytes.

**Trust ambient Node resolution after recording native files.** `NODE_PATH` and
symlink-preserving Node modes can redirect the official loader to a native that
the static adapter did not select. Later installation of a preferred platform
package can also leave every old artifact unchanged while changing the next
launch. The original fixed Codex-only Node options aligned runtime resolution with
canonical lookup, and repeated static selection verified that choice. The
replacement accepts the loader’s own resolution and its corresponding identity
limitation to avoid rejecting normal upstream upgrades.

## Consequences

Configuration consumers receive all three choices and cannot confuse missing
local values with an unadopted cloud setting. Existing unknown Worker fields
retain their compatibility behavior; only the tool-path mapping rejects unknown
tool keys. Diagnostics identify the field and rule without echoing arbitrary
input.

The resolver starts no process. Content verification proves the selected files
at the time of observation; it neither archives old binaries nor prevents an
authorized filesystem writer from replacing a file between verification and OS
loading. Existing process proof remains responsible for running-process identity
and cleanup. Script imports, OS libraries and native user configuration are not
part of the artifact set. The Codex loader’s dynamically selected native is not part of a new recipe
unless separately recorded by the resolver.

The [runtime integration decision](2026-11-12-worker-frozen-tool-runtime.md)
adds Web Task/Bot launch consumers, shared probes and a bounded Copilot authority
profile. That profile freezes its known preload closure and a complete private
distribution manifest in addition to the plain resolver dependencies. The
[Herdr launch decision](2026-11-12-herdr-frozen-tool-launch.md) owns controlled
pane mapping and frozen instance selection. A successful parse alone still does not prove
that a file exists, that a tool can run, that its protocol is compatible, or that
the Worker has applied the selection.
