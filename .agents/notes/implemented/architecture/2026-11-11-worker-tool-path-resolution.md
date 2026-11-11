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

Node entries use the fixed Worker Node executable. Known npm shim templates are
validated completely and unpacked statically. Official Copilot entry resolution
uses the native package belonging to that installation. Official Codex retains
the loader while recording its selected native and manifests; complete known
loader content identifies supported layouts. Unknown wrappers are refused rather
than interpreted as shell commands. Native arguments remain separate.

Shim target extraction and complete template validation use one bounded byte
snapshot. The registered template supplies the prefix and validates the rendered
target in every branch; suffix matching is case-insensitive without rewriting
the selected pathname. The pathname-only `read-cmd-shim` API would reopen the file
outside these bounds and dispatch uppercase `.CMD` names to the wrong parser.

Both metadata reads and artifact hashes open POSIX files with `O_NONBLOCK` before
checking the opened descriptor's regular-file type. A pathname precheck cannot
prevent replacement with a FIFO before open, and an operation timeout cannot
cancel a blocking kernel open or free its filesystem worker. Descriptor checks
and bounded close retain ownership on errors and cancellation; supported symlink
mapping checks remain independent.

Official Codex alone uses the frozen Worker Node with
`["--no-global-search-paths", "--no-preserve-symlinks", "--no-preserve-symlinks-main", canonicalLoader, ...args]`.
The official loader remains byte-for-byte unchanged. These options constrain its
native package selection to the canonical resolution modeled by the static
adapter, excluding `NODE_PATH` and symlink-preserving module search. Ordinary
Node scripts keep Node plus their canonical script. The adapter searches
ancestor `node_modules` directories from the actual loader directory and derives
the native path from the canonical manifest location. A candidate belonging to
another installation is an error, not a reason to search for a substitute.

Streaming hashes and mapping checks cover the entry, supported wrappers,
interpreter and selected native artifacts. Verification reads the frozen launch
and repeats static launcher selection from its original entry without consulting
new configuration or PATH. Comparing that result with the frozen recipe detects
a newly installed higher-priority platform package even when the recorded vendor
binary and loader have not changed. `selectionKey` retains lexical
artifact paths so changed symlink mappings remain detectable. A separate
`probeResourceKey` removes lexical aliases and selection-only PATH/PATHEXT while
retaining canonical content, cwd and other native environment isolation. Two
aliases for the same program can therefore share a future probe cleanup owner
without losing their distinct entry-verification obligations.
Windows search keys are normalized before exclusion. POSIX environment names
remain case-sensitive, so a native variable such as `Path` still isolates probes.

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
does not prove an interpreter choice. Complete known templates and a fixed
Worker Node make the launch recipe explicit; unsupported wrappers require a
supported entry or native path.

**Fingerprint only the entry or use its selection key as a probe lock.** An
unchanged official loader can start a replaced native binary. Lexically distinct
symlinks can also name the same program and bypass a lock keyed by entry spelling.
Artifact verification and a separate canonical resource key cover these two
different responsibilities.

**Trust ambient Node resolution after recording native files.** `NODE_PATH` and
symlink-preserving Node modes can redirect the official loader to a native that
the static adapter did not select. Later installation of a preferred platform
package can also leave every old artifact unchanged while changing the next
launch. Fixed Codex-only Node options align runtime resolution with canonical
lookup; repeating static selection verifies the choice as well as file contents.

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
part of the artifact set. Known loader/template registration requires explicit
updates as supported upstream formats change.

Worker Task/Bot launches, Herdr instances and version/capability probes do not
consume these choices yet. Cloud configuration exchanges negotiated choices but
does not apply them. A successful parse does not
prove that a file exists, that a tool can run, that its protocol is compatible,
or that the Worker has applied the selection. Runtime integration must preserve
those distinctions when it begins consuming the shared choice contract.
