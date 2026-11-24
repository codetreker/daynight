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
	UploadVersion                                   int
	SuccessorFileID                                 string
	TerminalError                                   json.RawMessage
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

// SessionArchiveFailureDAO records a definite failure while comparing the
// original file identity and metadata in the caller's locked transaction.
type SessionArchiveFailureDAO interface {
	FailSessionArchiveFile(context.Context, ArchiveBundleFile, json.RawMessage) error
}

// SessionArchiveHandoffDAO changes only the active writer under the caller's
// validated generation stop proof. The preparation and all file identities stay.
type SessionArchiveHandoffDAO interface {
	RebindSessionArchiveBundle(context.Context, string, json.RawMessage, json.RawMessage) error
}

// SessionArchiveResourceMigrationDAO converts an unchanged legacy inline row
// after its original bytes are durable in external storage.
type SessionArchiveResourceMigrationDAO interface {
	MigrateSessionArchiveResource(context.Context, SessionResourceRecord, SessionResourceRecord) error
}

// ArchiveStagingRecord is the database identity and durable business receipt of
// a v2 upload. Receiving progress belongs to storage, not this record.
type ArchiveStagingRecord struct {
	SessionID, FileID, Purpose, SHA256, State, Path, SuccessorFileID string
	ByteLength, TerminalOffset, TimelineRevision                     int64
	StagingReleased                                                  bool
	Resource, TerminalError                                          json.RawMessage
}

// SessionArchiveStagingDAO is transaction-bound. Callers hold the Session's
// storage exclusion across creation, admission recheck, and business changes.
// A false conditional write means the caller must read the original identity.
type SessionArchiveStagingDAO interface {
	ArchiveStagingRecord(context.Context, string, string) (ArchiveStagingRecord, error)
	ArchiveStagingRecords(context.Context, string) ([]ArchiveStagingRecord, error)
	InsertArchiveStaging(context.Context, ArchiveStagingRecord) (bool, error)
	FinishArchiveStaging(context.Context, ArchiveStagingRecord, string, int64, json.RawMessage) (bool, error)
	SetArchiveStagingSuccessor(context.Context, ArchiveStagingRecord, string) (bool, error)
	ReleaseArchiveStaging(context.Context, ArchiveStagingRecord) (bool, error)
}
