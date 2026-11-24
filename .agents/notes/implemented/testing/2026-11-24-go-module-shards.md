# Agent Note: Shard Go Module Verification

Status: implemented

## Problem

The module verification job ran all ordinary Go packages at concurrency two.
Slow runners extended package execution well past the time spent in the Store
root. Increasing process concurrency on its shared PostgreSQL instance would
also increase contention on the database-wide migration advisory lock. Module
coverage needs the execution of the full ordinary suite, including calls across
package boundaries.

## Decision

CI runs a Store root shard, two PostgreSQL DAO shards and a shard for the rest
of the module, each with its own PostgreSQL and Redis. The root keeps its
dedicated database. All test shards use concurrency two, use the same module-wide
atomic coverage universe and force uncached test execution. The preflight
runs vet, validation script tests, explicit fixture tests, and Azure tests in
parallel. The shard containing the server authentication tests prepares the
pinned UniAuth fixture it uses.

The module coverage job checks the exact source revision and race setting,
the complete package partition, and terminal results from each successful Go
capture. It merges the executed atomic profiles and supplies the real Go
events and merged profile to the pinned `go-cov` reporter. The original
package, function and total coverage checks still run, followed by the strict
unrounded statement check. The module gate requires the preflight and all
test shards. Command lifecycle coverage remains independent. Local module
validation keeps its ordinary single-invocation command.

## Alternatives

**Raise package concurrency on the same runner.** The heavy packages initialize
schemas on a database with shared advisory locks. More local package slots
would put their schema and compilation work on the same resources.

**Evaluate independent coverage thresholds per shard.** A package may execute
through tests assigned to another shard. The whole module needs a single
coverage universe and one merged coverage gate.

## Consequences

The elapsed Go module path includes the slowest shard and the final module
gate. Shards repeat some build and service setup on separate runners. Package
assignment is deterministic and uses ordinary Go discovery, so new packages
enter a shard without a second package inventory. The start and completion
timestamps of the actual hosted jobs establish workflow time.
