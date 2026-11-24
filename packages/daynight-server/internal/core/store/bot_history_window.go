package store

import "context"

// BotHistoryWindowDAO retains only the authoritative window checkpoint and
// reclamation responsibility. All methods require the caller's Session lock.
type BotHistoryWindowDAO interface {
	BotHistoryCheckpoint(context.Context, string) ([]byte, error)
	SaveBotHistoryCheckpoint(context.Context, string, []byte) error
	SessionResourceReferences(context.Context, string, string) ([]SessionResourceReference, error)
	QueueBotHistoryReclaim(context.Context, string, string) error
	PendingBotHistoryReclaims(context.Context, string) ([]string, error)
	CompleteBotHistoryReclaim(context.Context, string, string) error
}

// BotHistoryReclaimInventoryDAO discovers bounded maintenance work without
// authorizing any resource mutation. Each target is locked and checked again.
type BotHistoryReclaimInventoryDAO interface {
	BotHistoryReclaimSessions(context.Context, string, int) ([]string, error)
}
