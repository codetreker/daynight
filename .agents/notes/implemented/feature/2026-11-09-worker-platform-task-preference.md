# Agent Note: Per-Worker Platform Task Preference

Status: implemented

## Problem

A Worker can use its platform-specific capacity on an unrestricted task while
an eligible task requiring that platform waits in another configured Project.
Compatibility filtering admits both categories and chronological ordering does
not reserve that capacity for platform-specific work. Different Workers need
different acquisition preferences. Sharing a rotation position between categories
also lets blocked or intermittent platform-specific work repeatedly displace
unrestricted tasks in one Project.

## Decision

Each Worker has a cloud-managed `preferPlatformSpecificTasks` boolean, initially
false. It is editable in My Workers and hot-applied to subsequent acquisition.
The control names the viewed Worker’s platform using the shared display names;
when its platform is unavailable, the control retains a generic label.
Local YAML supplies the initial import only; later cloud values retain authority.
The setting is independent of native execution configuration and does not change
existing claims or pending startup priority.

An enabled coordinator scans eligible Projects for exact-platform candidates
before considering unrestricted candidates. Platform-specific and ordinary
acquisition retain independent Project rotation positions. Ordinary acquisition
covers unrestricted candidates when enabled and the original mixed compatible
stream when disabled. Scanning, skipping or claiming preferred work never advances
the ordinary position; each category preserves chronological task ordering. The
list-only `platformSpecific`
filter combines with `compatiblePlatform` before pagination; each category has
its own filter-bound cursor. The chronological position key remains unchanged.
Disabled Workers retain their original mixed candidate stream. The
[Worker requirements](../../../../docs/spec/daynight-worker.md) own the observable
ordering and the [configuration protocol](../../../../docs/spec/daynight-worker-configuration.md)
owns the target and application values.

The server migrates initialized targets to include false without changing
configuration versions, timestamps or prior observations. Platform preference
was introduced in local schema 2 with an explicit schema 1 migration. The current
[fact representation](../architecture/2026-11-12-worker-configuration-fact-separation.md)
upgrades schemas 1–4 to schema 5 and preserves that field migration, removals,
backoff and failure identity. The original observation bound grew from 1024 to
1025 for the additional global item; current non-mode batches retain 1025 while
local historical responsibility is independent of a single batch. Target parsers
remain strict; false is an applied value and null is an unconfirmed value.

The [single-acquisition decision](../../archived/feature/2026-11-04-worker-single-acquisition.md)
retains the rationale for one new claim per round. The
[capacity decision](../architecture/2026-11-07-worker-current-capacity.md)
retains the requirement to preserve unresolved application records.

## Alternatives

**Enable platform priority for every Worker.** This serves platform-specific
work sooner but removes control over which Workers devote capacity to it. An
independent opt-in preserves the existing policy where it is still desired.

**Change only the order of each Project's compatible tasks.** A generic task in
the first Project can still precede a dedicated task elsewhere. Changing SQL
ordering alone also disagrees with the chronological cursor and can skip tasks.
Separate server-filtered categories preserve pagination and cover all Projects.

**Restore a shared position only after unsuccessful preferred scans.** This
prevents blocked preferred work from redirecting the fallback scan, but successful
preferred claims still change its starting Project. Intermittent preferred work
can therefore repeatedly displace unrestricted tasks. Independent positions keep
the required category-local rotation across both successful and exhausted scans.

**Sort a received candidate page.** A platform-specific task on a later page
would remain hidden behind unrestricted rows, so this cannot establish priority
over the complete eligible set.

## Consequences

Selected Workers reserve their next available acquisition for platform-specific
work when such candidates exist. Continuous eligible platform-specific work can
delay unrestricted tasks on those Workers; disabled Workers retain their normal
mixed ordering. The preference is a Worker selection policy, not a server-wide
priority lock, and claim admission still rechecks the original qualifications
and exact version.

Finding no dedicated candidate requires scanning that category across eligible
Projects before unrestricted acquisition. The additional list condition is
independent of search and single-request ready selectors. The new required cloud
field and local cache version require compatible service and Worker binaries;
older strict clients cannot consume the expanded target.
