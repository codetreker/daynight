package filestorage

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
)

// ErrArchiveBlockConflict means an existing block has different bytes.
var ErrArchiveBlockConflict = errors.New("archive block conflicts with existing object")

// ArchiveBlockStorage publishes immutable v2 archive blocks. The caller holds
// the Session archive permit and durable I/O lease across this operation.
// A successful return proves the exact bytes and their directory entries are
// durable, including when an existing object was reused. PublicationError
// preserves the publication outcome when the operation fails.
type ArchiveBlockStorage interface {
	PutArchiveBlock(context.Context, sessionarchive.Namespace, string, int64, []byte) error
}

// ArchiveBlockDeleter durably removes one v2 block. The caller holds the
// Session archive permit and has drained the original writers. Success includes
// directory barriers even when the block or a parent was already absent.
type ArchiveBlockDeleter interface {
	DeleteArchiveBlock(context.Context, sessionarchive.Namespace, string, int64) error
}

// ArchiveStagingDeleter durably removes an assembled archive staging object.
// The caller holds the Session archive permit, has drained the original writers,
// and has determined that the object is no longer needed. Success includes
// directory barriers even when the object or a parent was already absent.
type ArchiveStagingDeleter interface {
	DeleteArchiveStaging(context.Context, string, string) error
}
