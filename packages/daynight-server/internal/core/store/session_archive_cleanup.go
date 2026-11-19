package store

import (
	"context"
	"time"
)

// ArchiveCleanupTarget is a storage-observed ordinary Web Task archive identity.
// Callers must not use a list result as expiration authority.
type ArchiveCleanupTarget struct {
	ProjectID, TaskID, SessionID, OwnerID string
	ExpiredAt, CleanedAt                  *time.Time
}

// ArchiveCleanupScope holds Project then Session locks. Retention and resource
// capabilities share its transaction; no filesystem work belongs in this scope.
type ArchiveCleanupScope interface {
	RetentionDAO() ArchiveRetentionDAO
	SessionDAO() SessionDAO
	Target() ArchiveCleanupTarget
	ExpireArchive(context.Context, int64, time.Time) error
	CompleteArchiveCleanup(context.Context, time.Time) error
}

type ArchiveCleanupStore interface {
	// ListArchiveCleanup walks UUID order, including decisions without cached
	// deadlines. Resume after the last result and reset the cursor on exhaustion.
	ListArchiveCleanup(context.Context, string, int) ([]ArchiveCleanupTarget, error)
	WriteArchiveCleanup(context.Context, ArchiveCleanupTarget, func(ArchiveCleanupScope) error) (Completion, error)
}

// SessionArchiveExpiryDAO is checked inside the caller's authorized Session
// scope. Absence of retention metadata is not expiration.
type SessionArchiveExpiryDAO interface {
	SessionArchiveExpired(context.Context, string) (bool, error)
}
