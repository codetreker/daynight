package store

import (
	"context"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

// BotDeletionBindingReader reads the retained Session identity in the caller's
// snapshot, including after the Bot deletion barrier has been committed.
type BotDeletionBindingReader interface {
	BotDeletionBinding(context.Context, string, string) (sp.Snapshot, error)
}
