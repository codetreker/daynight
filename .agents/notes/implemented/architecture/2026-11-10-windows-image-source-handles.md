# Agent Note: Windows image source ancestry uses parent handles

Status: implemented

## Problem

A checked Windows directory can become a junction while its original handle and
file ID remain valid. Reopening its child by a complete pathname can then reach
another directory. Local image authorization must preserve the original root and
checked ancestry while supporting known links, parent components and cwd aliases.

## Decision

The Windows portion of the [source decision](2026-11-05-session-image-sources.md)
uses `NtCreateFile` with `RootDirectory` set to the held parent handle and a name
containing exactly one component. `FILE_OPEN_REPARSE_POINT` opens the component
without following its link; the opener decodes only known symlink and junction
substitutions. A held directory stack gives `..` its actual ancestry and prevents
escape from the authorized root. This applies to cwd resolution, absolute source
prefixes, source components and the existing output reservation.

Only the initial local drive root is opened with `CreateFileW`. Its volume GUID
pathname is diagnostic; no later open resolves that pathname. The opener holds
all checked ancestors without write/delete sharing to protect contents and
renames. Those sharing flags are supplementary: an attribute-only handle can
still set reparse data without replacing the object or changing its file ID.

The original source design allowed either handle-relative traversal or complete
pathnames with all ancestors held without write/delete sharing. The latter was
intended to prevent directory substitution because normal writes and renames
conflict with those shares. It did not account for `FILE_WRITE_ATTRIBUTES`, which
[allows setting reparse data](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4aeefef8-92c3-4abc-af7a-a610caf8a165).
This decision replaces that alternative; the other source ownership, immutable
snapshot and permission requirements remain with the source decision and
[current design](../../../../docs/design/session-image-sources.md).

Cwd aliases are resolved through the same component mechanism and compared with
the persisted original `expectedRoot`. An absolute source prefix must reach that
root's actual volume/file ID before the remaining components are resolved within
it. A textual drive or case-insensitive prefix grants no authority.

Only fixed local NTFS volumes are accepted. Node's persisted `stat` identity
contains a 64-bit file index; ReFS does not guarantee its uniqueness. ReFS needs a
trusted context contract that captures and persists its complete 128-bit file ID
before source IO. The opener uses full volume/file IDs during traversal without
pretending that this repairs an incomplete original identity.

## Alternatives

**Reopen complete paths while denying write/delete sharing.** This protects
renames and data writes but permits a checked empty directory to become a
junction through an attribute-only handle. A same-ID check does not detect the
change, and another pathname open can follow the new intermediate target.

**Recheck attributes around complete pathname opens.** A concurrent process can
change the reparse data between checks and restore it afterward. Repeated checks
cannot make the pathname lookup refer to the originally checked parent.

**Use realpath before ordinary open.** Resolving a candidate path does not bind
its later open to the same directory objects. It retains the substitution race
and cannot preserve a symlink followed by `..` through lexical normalization.

**Refuse every Windows context or every cwd alias.** Blanket refusal prevents
unsafe reads but removes required local-source success paths. Checked explicit
link expansion preserves those paths without trusting alias spelling.

**Accept ReFS using the existing stat identity.** This would claim an original
root binding stronger than the persisted identity can establish. Reconsider it
when the trusted context owns full ReFS identity capture and persistence.

## Consequences

The opener depends on the native `NtCreateFile` ABI, counted UTF-16 names and
NTSTATUS conversion. Synchronous IO supports the existing bounded block copier;
the separate helper retains actual termination and join on cancellation or
timeout. The component mechanism adds native platform maintenance but avoids
ancestry being reinterpreted during a later pathname lookup.

Windows acceptance must execute real handles, including an attribute-only
`FSCTL_SET_REPARSE_POINT` mutation that succeeds with unchanged file ID, and
prove that external bytes are not copied. Parser or non-Windows helper tests do
not establish that guarantee. Native Read-policy proof and deployment egress
proof remain separate unmet source requirements; the real runtime stays closed
when those proofs are absent. This decision provides neither a transactional
source snapshot nor isolation from a malicious process with the same OS identity.
