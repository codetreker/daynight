package store

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// WorkerClaimAdmissionDAO reads authoritative targets in a Project write transaction.
type WorkerClaimAdmissionDAO interface {
	// ClaimWorkerConfiguration locks the Worker until transaction completion. A
	// missing Worker is protected against first-report insertion for that lifetime.
	// Nil means no initialized target; read and cancellation errors are returned.
	// Only Raw, Revision and UpdatedAt are populated; unrelated configuration and
	// observation fields are not interpreted.
	ClaimWorkerConfiguration(context.Context, string, string) (*model.WorkerDesiredConfiguration, error)
}
