package store

import "context"

// BotDeletionRecoveryLister lists only pending owner decisions or retained
// decisions, with filtering and pagination performed in the snapshot query.
type BotDeletionRecoveryLister interface {
	BotDeletionRecoveries(context.Context, string, Page) (BotPage, error)
}
