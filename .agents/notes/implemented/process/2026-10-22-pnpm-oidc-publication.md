# Agent Note: pnpm Toolchain and OIDC Publication

Status: implemented

## Problem

The [publication of 0.8.11](https://github.com/codetreker/daynight/actions/runs/39718345337/job/119626262962)
passed CLI validation and package installation but stopped before upload with
`ENEEDAUTH`. npm 12.2.0 logs OIDC exchange failures only at verbose level before
falling back to ordinary authentication, so the retained job log does not reveal
the underlying exchange error. The publishing client needs a proven OIDC path
and visible authentication failures without losing the validated package's
source identity.

## Decision

The [publication workflow](../../../../.github/workflows/publish.yml) installs
pnpm 11.28.6 for publication. The workspace package-manager pin, CI setup and
Docker frontend build use that same version, matching the client that successfully
published Borgee's plugin in
[run 39372386301](https://github.com/gim-home/borgee/actions/runs/39372386301/job/118463137740).
That run used Node 24.21.0, the same Node version as the failed Daynight run.
The [Borgee workflow](https://github.com/gim-home/borgee/blob/ba2b503e1c6e994ef5acc15024848a7b66945f09/.github/workflows/publish.yml#L357-L413)
uses pnpm 11 with `--pm-on-fail=ignore`, public access and Git checks disabled.

Upload invokes the installed pnpm CLI through Node using `PNPM_CLI_JS`, with
the already prepared tarball as its input. The explicit path and
`--pm-on-fail=ignore` keep the publishing job on its explicitly installed client.
No project dependency installation is needed
in the privileged job. `setup-node` configures the npmjs registry, and the child
inherits that configuration and GitHub's OIDC environment. Lifecycle scripts
remain disabled. Missing publisher configuration and nonzero publisher exits
remain failures under the existing bounded upload process.

pnpm performs its own
[OIDC exchange](https://github.com/pnpm/pnpm/blob/fe4a0c232384289de82be3d502896ca7e070050c/pnpm11/releasing/commands/src/publish/publishPackedPkg.ts#L321-L379)
and executes its bundled publishing library. Installing or upgrading a separate
npm CLI does not select this authentication implementation. pnpm reports
recognized OIDC failures as warnings; it does not guarantee that an incorrectly
configured trusted publisher will succeed.

pnpm 11 reads package-manager settings from `pnpm-workspace.yaml`, so
`engineStrict: true` and `storeDir: .tmp/pnpm-store` move there from `.npmrc`.
The existing `allowBuilds` entries and dependency patches remain in place. The
empty `.npmrc` is removed, and Docker copies the workspace settings before its
frozen install. The lockfile is regenerated with pnpm 11 while retaining pinned
dependency versions. The package version advances because workspace and
lockfile changes are release inputs. The
[pnpm migration guide](https://github.com/pnpm/pnpm/blob/fe4a0c232384289de82be3d502896ca7e070050c/pnpm11/docs/migration.md)
owns the configuration changes.

Metadata queries retain npm 12.2.0 and the
rules owned by the [npm CLI publication-check decision](2026-10-22-npm-cli-publication-checks.md).
Source-bound artifacts, public byte verification and immutable tags retain the
choices recorded in the
[trusted-publishing decision](../../archived/process/2026-10-20-npm-trusted-publishing.md).
The [CLI validation decision](2026-10-22-cli-publication-validation.md) continues
to exclude unrelated module results from release admission.

GitHub and npm retain the package's existing publisher identity: repository
`codetreker/daynight`, workflow `publish.yml`, and no GitHub Environment. Borgee's
package-specific Environment cannot identify this package. Public Daynight
releases retain provenance; Borgee disables it because its source repository is
private. Neither difference changes the selected pnpm OIDC implementation.

## Alternatives

**Keep npm 12.2.0 and expose verbose errors.** This would improve diagnosis,
but would retain the client that produced the observed authentication failure.
Using Borgee's tested publishing client satisfies the chosen alignment without
asserting that npm's supported version range caused the failure.

**Keep pnpm 10 for builds and pnpm 11 for publication.** This limits the
installation migration to the publishing job, but retains two package-manager
versions and separate configuration behavior. A unified pnpm 11 pin keeps local
development, CI, Docker and publication on one supported toolchain; the upgrade
therefore includes the configuration migration and validation of its consumers.

**Copy Borgee's Environment and disable provenance.** Its Environment belongs
to a different npm publisher identity, and its provenance restriction follows
from private source visibility. Retaining Daynight's publisher identity and
public provenance preserves its existing release contract.

## Consequences

Publication uses the same pnpm release and OIDC implementation as Borgee's
successful plugin publication. The frozen tarball remains the input to upload
and to subsequent registry byte verification; the publishing job does not
rebuild or repack the CLI. Existing-version skips and duplicate-upload handling
remain independent of the upload client.

Local fixture validation can establish CLI selection, tarball preservation,
authentication request handling and failure propagation. Only an authorized
hosted publication can establish that the real GitHub identity is accepted by
the package's npm trusted-publisher configuration.
