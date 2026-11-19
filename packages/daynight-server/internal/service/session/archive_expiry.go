package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// The caller has already authorized the exact Session and holds its lock.
// Summary queries and operation receipts do not use this content admission.
func requireArchiveReadable(ctx context.Context, dao store.SessionDAO, id string) error {
	if expiry, ok := dao.(store.SessionArchiveExpiryDAO); ok {
		expired, err := expiry.SessionArchiveExpired(ctx, id)
		if err != nil {
			return err
		}
		if expired {
			return &model.Fault{Code: "history_unavailable", Message: "Session history has expired."}
		}
	}
	return nil
}
