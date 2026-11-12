package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// CredentialUsageWriter atomically persists a nonempty batch of at most 128
// unique events, ordered by kind, user ID and subject ID. Events identify
// canonical UUIDs and carry nonzero UTC times at microsecond precision.
// Missing objects and older events are successful no-ops. Completion describes
// the transaction, not any asynchronous driver cleanup; persistence Close joins
// the pool's resources.
type CredentialUsageWriter interface {
	WriteCredentialUsage(context.Context, []model.CredentialUsageEvent) (Completion, error)
}
