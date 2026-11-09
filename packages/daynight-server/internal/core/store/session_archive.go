package store

import (
	"context"
	"encoding/json"
)

// ArchiveBundle stores only bounded ownership, integrity, reference and commit metadata.
// Timeline and original bytes remain in file storage.
type ArchiveBundle struct {
	SessionID, PrepareID, Phase, HistoryID, TimelineID, ManifestPath, ManifestHash, ManifestLength string
	Revision                                                                                       int64
	Identity, Resources, Ledger                                                                    json.RawMessage
}
type ArchiveBundleFile struct {
	SessionID, FileID, Purpose, SHA256, State, Path string
	ByteLength, AcceptedOffset                      int64
	TimelineRevision                                int64
	StagingReleased                                 bool
	Resource                                        json.RawMessage
}
type ArchiveMigration struct {
	SessionID, MigrationID, SourcePath, SourceHash, TargetPath, TargetHash, Phase string
	SourceLength                                                                  int64
}
type ArchiveBundleChunk struct {
	SessionID, FileID, Path, SHA256 string
	Offset, ByteLength              int64
}

// SessionArchiveDAO is an optional capability on a Session's transaction-bound DAO.
type SessionArchiveDAO interface {
	SessionArchiveBundle(context.Context, string) (ArchiveBundle, error)
	SaveSessionArchiveBundle(context.Context, ArchiveBundle) error
	SessionArchiveFile(context.Context, string, string) (ArchiveBundleFile, error)
	SaveSessionArchiveFile(context.Context, ArchiveBundleFile) error
	SessionArchiveFiles(context.Context, string) ([]ArchiveBundleFile, error)
	SessionArchiveChunks(context.Context, string, string) ([]ArchiveBundleChunk, error)
	InsertSessionArchiveChunk(context.Context, ArchiveBundleChunk) error
	SessionArchiveMigration(context.Context, string) (ArchiveMigration, error)
	SaveSessionArchiveMigration(context.Context, ArchiveMigration) error
	SetUnifiedSessionArchiveReady(context.Context, string, string, int, string, string) error
}

// SessionArchiveHandoffDAO changes only the active writer under the caller's
// validated generation stop proof. The preparation and all file identities stay.
type SessionArchiveHandoffDAO interface {
	RebindSessionArchiveBundle(context.Context, string, json.RawMessage, json.RawMessage) error
}
