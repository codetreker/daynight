package store

import (
	"context"
	"time"
)

// HistoryDirectoryReader binds authorization, graph membership and archive facts
// to one repeatable snapshot. Returned scopes must not escape the callback.
type HistoryDirectoryReader interface {
	ReadHistoryDirectory(context.Context, func(HistoryDirectoryScope) error) error
}

type HistoryDirectoryScope interface {
	SnapshotScope
	HistoryDirectoryDAO() HistoryDirectoryDAO
}

type HistoryGroupPosition struct {
	ID      string
	EndedAt *time.Time
}

type HistoryDirectoryGroup struct {
	ID          string
	MemberCount int
	EndedAt     *time.Time
	TimeState   string
}

type HistoryDirectoryMember struct {
	ArchiveRetentionMember
	Title string
}

type HistoryDirectorySession struct {
	// Snapshot and Terminal remain empty: directory reads project only the
	// execution generation and final stopped time from potentially large JSON.
	TerminalHistoryRow
	ExecutionGeneration string
	EndedAt             *string
	Retention           *ArchiveRetention
}

// Limits are the exact row count, including any caller-requested lookahead.
// Group IDs are the least UUID in the current ordinary dependency component.
// Fence changes invalidate paging positions; it covers directory-visible task,
// Session, archive and retention facts, not transient connection heartbeats.
type HistoryDirectoryDAO interface {
	Fence(context.Context, string) (string, error)
	Groups(context.Context, string, *HistoryGroupPosition, int) ([]HistoryDirectoryGroup, error)
	Members(context.Context, string, string, string, int) ([]HistoryDirectoryMember, error)
	Sessions(context.Context, string, string, *Position, int) ([]HistoryDirectorySession, error)
	RetentionMembers(context.Context, string, string) ([]ArchiveRetentionMember, error)
}
