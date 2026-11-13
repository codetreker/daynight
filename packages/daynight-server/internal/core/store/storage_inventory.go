package store

import sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"

// StorageInventory is a read-only database snapshot used after restoring the
// database and file volume from the same stopped-writer backup cut.
type StorageInventory struct {
	SessionID, ProjectID, OwnerID string
	Archive                       *StorageArchive
	Migration                     *ArchiveMigration
	Resources                     []SessionResourceRecord
	Objects                       []StorageObject
	InlineResources               []StorageInlineResource
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
