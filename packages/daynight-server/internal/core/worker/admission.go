package worker

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ActiveAt uses the server's successful report time, including the upper bound.
func ActiveAt(lastSeen, observedAt time.Time) bool {
	return !lastSeen.IsZero() && !observedAt.IsZero() && !lastSeen.After(observedAt) && observedAt.Sub(lastSeen) < ActiveWindow
}

// AdmitActiveWorker evaluates the complete owner count at the locked observation.
func AdmitActiveWorker(admission store.WorkerAdmission) error {
	active := admission.LastSeenAt != nil && ActiveAt(*admission.LastSeenAt, admission.ObservedAt)
	if admission.ActiveCount > MaxActiveWorkers || (admission.ActiveCount == MaxActiveWorkers && !active) {
		return &model.Fault{Code: "active_worker_limit_exceeded", Message: "Active worker limit exceeded."}
	}
	return nil
}
