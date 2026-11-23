package store

import (
	"encoding/json"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

// StorageInventory is a read-only database snapshot used after restoring the
// database and file volume from the same stopped-writer backup cut.
type StorageInventory struct {
	SessionID, ProjectID, OwnerID string
	Archive                       *StorageArchive
	Migration                     *ArchiveMigration
	Resources                     []SessionResourceRecord
	Objects                       []StorageObject
	InlineResources               []StorageInlineResource
	ArchiveFilesV2                []StorageArchiveFileV2
	ArchiveBundle                 *ArchiveBundle
	ArchiveTimeline               *StorageArchiveTimeline
}

// StorageArchiveFileV2 retains the facts needed to verify a resumable upload
// and its durable receipt without treating unconfirmed staging as required data.
type StorageArchiveFileV2 struct {
	UploadVersion                                         int
	FileID, Purpose, SHA256, State, Path, SuccessorFileID string
	ByteLength, AcceptedOffset, TimelineRevision          int64
	PrefixProof                                           []byte
	Resource, TerminalError                               json.RawMessage
	StagingReleased                                       bool
}

// StorageArchiveTimeline identifies the bundle's current timeline independently
// of its upload version. It is read from the same snapshot as the bundle.
type StorageArchiveTimeline struct {
	FileID, State, Path, SHA256                  string
	UploadVersion                                int
	ByteLength, AcceptedOffset, TimelineRevision int64
}

type StorageArchive struct {
	SchemaVersion int
	Path, SHA256  string
	ByteLength    int64
}
type StorageObject struct {
	Bucket, Path, SHA256 string
	ByteLength           int64
	// Optional permits absence of an unconfirmed first image chunk; present bytes
	// still require the same integrity verification as a confirmed object.
	Optional bool
}
type StorageInlineResource struct {
	Resource sp.Resource
	Content  []byte
}
