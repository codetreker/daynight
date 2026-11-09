package store

import (
	"context"
	"time"
)

// SessionResourceSettlementDAO uses the caller's authorized Session lock.
// A reclaim marker excludes new pins without returning quota before blob cleanup.
type SessionResourceSettlementDAO interface {
	ListSessionUploadsForSettlement(context.Context, string, time.Time) ([]SessionUploadRecord, error)
	MarkSessionResourceReclaim(context.Context, string, string) (bool, error)
	DeleteReclaimedSessionResource(context.Context, string, string) error
}
