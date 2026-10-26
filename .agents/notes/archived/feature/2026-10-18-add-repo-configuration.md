# Agent Note: Repository Registration and Fixed Clone Paths

Status: implemented

## Problem

Registering a repository requires a correct remote identity and a dedicated clone
location. Requiring users to derive every location makes routine configuration
editing error-prone. A shared default location must not silently relocate existing
clones when the default changes, and concurrent additions must not erase each
other's configuration.

## Decision

`daynight review add-repo <remote> [--path <path>]` reads, validates and writes the fixed
user-home YAML configuration. It creates initial configuration when absent and
preserves existing settings and comments when adding a repository. The
[requirements](../../../../docs/spec/daynight-review.md) own observable behavior; the
[configuration design](../../../../docs/design/daynight-review.md) owns path resolution
and save mechanics. The
[user-home configuration decision](../architecture/2026-10-16-user-home-review-configuration.md)
continues to own the configuration and retained-state locations.

`repositoryRoot` defaults to `~/daynights`. Only registration without an explicit
path uses it: normalized host/owner/name supplies filesystem-safe components under
that root, and the resulting absolute path is saved in the repository entry.
An explicit path resolves against the caller's working directory and is also
saved absolutely. Every entry retains a required `path`; review startup never
derives clone paths from the global root. Changing the root affects future
additions only. Existing hand-written relative repository paths keep their
configuration-directory-relative meaning.

The command reuses review field and filesystem-identity validation. Shared
`config/` modules own document parsing and the atomic save protocol. A file with
only server settings can receive its first review repository; existing malformed
review values still fail, while server values remain unchanged and unvalidated
by review. The [project/task design](../architecture/2026-10-20-project-task-cli-design.md)
owns the server projection.
Adding an existing normalized repository without an explicit path reuses the saved
path, including after root changes. An explicit path to the same actual location
also succeeds without a write; an explicit different path is a conflict. An exclusive separate
configuration lock covers read, validation and replacement. A concurrent writer
fails clearly, allowing a later invocation to read the completed configuration.
The writer preserves existing permission mode and replaces the configuration
through a temporary file in the same directory. Validation and pre-replacement
write failures preserve the original file; cleanup errors after replacement remain
visible. Mutation requires a regular
configuration file and rejects symlinks.

The [guided setup decision](2026-10-21-guided-configuration-setup.md) reuses this
registration operation for explicit setup and missing-review configuration prompts.
The shared updater composes repository registration with an optional server change
in one locked configuration transaction. Existing path and idempotency rules remain
owned here.

Registration is a configuration operation. It does not clone, check credentials,
query GitHub, initialize SQLite or choose the permanent PR boundary. A running
reviewer keeps its loaded configuration; the next startup performs the normal
repository lifecycle. The save result identifies configuration persistence, not
active monitoring.

## Alternatives

**Derive missing repository paths from the global root at every startup.** This
would let entries omit `path`, but editing one global setting would redirect
existing repositories and their worktrees. Persisting the derived path makes the
addition root a predictable default without becoming a relocation mechanism.

**Require an explicit clone path for every addition.** This keeps registration
independent of a global root, but repeats path selection for each repository.
The normalized host/owner/name layout supplies a default while the saved explicit
path preserves independent control.

**Activate the repository during registration.** Immediate cloning or notifying
a running reviewer would couple configuration writes to authentication, network
access and PR initialization. Keeping those operations at review startup preserves
one owner for their ordering, permanent boundary selection and recovery. Live
activation would be a separate capability requiring an explicit runtime command
or reload protocol.

## Consequences

Changing a default is safe for existing repository locations. Repository entries
remain complete inputs to the existing runtime, so adding runtime activation later
can reuse those entries without changing their stored meaning. The current command
reports configuration saved; monitoring starts only at the next review startup,
and the permanent PR boundary is selected then through the normal initialization
flow.

Atomic replacement and serialized configuration commands are part of the delivered
guarantee. Concurrent commands may fail on the write lock and must be invoked
again after the other writer finishes. After an abnormal exit, an operator must
confirm no configuration writer remains before manually removing its lock.
Uncoordinated manual editors do not participate in this lock. Symlinked
configuration can still be loaded for review but cannot be changed by registration.

Runtime activation is deferred as an additive feature. It stays affordable because
registration has no dependency on runtime state, the review instance lock or a
running daemon. The default root does not provide relocation, credential setup or
repository preparation; these retain their existing owners and failure behavior.
