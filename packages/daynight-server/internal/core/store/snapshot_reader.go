package store

import (
	"context"
	"time"
)

// SnapshotReader runs the callback against one read-only, repeatable snapshot.
// The scope and its readers are valid only for the duration of the callback.
type SnapshotReader interface {
	ReadSnapshot(context.Context, func(SnapshotScope) error) error
}

type SnapshotScope interface {
	CredentialDAO() CredentialReader
	TeamDAO() TeamReader
	ProjectDAO() ProjectReader
	TaskDAO() TaskReader
	WorkerDAO() WorkerReader
	BotDAO() BotReader
	AttachmentDAO() AttachmentReader
	ObservedAt(context.Context) (time.Time, error)
}
