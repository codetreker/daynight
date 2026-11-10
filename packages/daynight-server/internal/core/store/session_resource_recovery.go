package store

import "context"

// SessionResourceLeaseRecoveryDAO enumerates deployment-wide I/O ownership for
// crash recovery. Callers must acquire the exact filesystem lease gate before
// deleting a row, and retain the gate until transaction completion is known.
// Recovery may release that lease without taking its Session lock only while
// holding this gate; it cannot change resource data or deletion admission.
type SessionResourceLeaseRecoveryDAO interface {
	ListSessionMediaLeases(context.Context) ([]SessionResourceLease, error)
}
