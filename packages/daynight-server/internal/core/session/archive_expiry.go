package session

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ExpireArchive refreshes the current chain under the cleanup transaction's
// Project and Session locks. Its result permits cleanup only after that
// transaction confirms commit; an elapsed cached deadline is never sufficient.
func ExpireArchive(ctx context.Context, scope store.ArchiveCleanupScope, now time.Time) (bool, error) {
	target := scope.Target()
	if target.CleanedAt != nil {
		return false, nil
	}
	if target.ExpiredAt != nil {
		return true, nil
	}
	retention, err := RefreshArchiveRetention(ctx, scope.RetentionDAO(), target.ProjectID, target.TaskID, target.SessionID)
	if err != nil {
		return false, err
	}
	if retention.ExpiresAt == nil || now.Before(*retention.ExpiresAt) {
		return false, nil
	}
	if err := scope.ExpireArchive(ctx, retention.Version, now.UTC()); err != nil {
		return false, err
	}
	return true, nil
}
