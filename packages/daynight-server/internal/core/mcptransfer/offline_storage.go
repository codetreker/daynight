package mcptransfer

import (
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// CloseOfflineTransfer follows the ordinary cleanup barrier after the target
// namespace is confirmed absent. Operation data and cleanup provenance survive.
func CloseOfflineTransfer(record model.PrivateTransfer, now time.Time) (model.PrivateTransfer, error) {
	switch record.State {
	case "receiving", "preparing", "readable", "committing", "committed", "failed", "unknown", "cleanup_pending":
	default:
		return record, errors.New("unsupported offline transfer state")
	}
	for _, next := range CleanupSteps(record, now, false) {
		if next.State == "cleanup_pending" {
			previous := record.State
			next.CleanupFromState = &previous
		}
		record = next
	}
	if record.State != "cleanup_pending" || record.CleanupFromState == nil {
		return record, errors.New("offline transfer has no cleanup barrier")
	}
	record.State = "closed"
	record.ReservedBytes, record.OutstandingBytes = 0, 0
	record.LeaseUntil = nil
	until := now.Add(Retention)
	record.RetainUntil = &until
	return record, nil
}
