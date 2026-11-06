package service

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// OpenAttachmentMaintenance assembles the dedicated offline maintenance session.
func OpenAttachmentMaintenance(ctx context.Context, databaseURL string) (store.AttachmentMaintenance, error) {
	return store.OpenAttachmentMaintenance(ctx, databaseURL)
}
