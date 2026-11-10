# Agent Note: OAuth maintenance test boundary

Status: implemented

## Problem

Service maintenance tests controlled the client DAO while executing Core's
batch and candidate decisions. This mixed cleanup coordination and runner
lifetime with the rules of the invoked operation, leaving the direct operation
arguments and dependency binding implicit.

## Decision

The maintenance constructor binds the private client cleanup operation to Core.
Service tests supply operation outcomes and verify the three independent budgets,
ordering, contexts, errors, startup scan and stop/drain behavior. A Core receiver
retains the empty 600-budget batch and lock failure inputs with independently
configured transaction completion and error.

## Alternatives

**Control only the client DAO in Service tests.** This exercises Core batching
as part of Service coordination and cannot independently supply client cleanup
results at the direct operation boundary.

## Consequences

Service proves coordination and lifecycle without claiming SQL persistence or
transaction completion. Core owns client candidate and batch decisions, while
storage tests retain database responsibilities. The private function member
adds an injection point and the constructor ensures the production binding.
No whole-suite speed improvement follows without measurement.
