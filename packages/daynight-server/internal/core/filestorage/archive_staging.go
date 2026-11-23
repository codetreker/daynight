package filestorage

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/google/uuid"
)

var ErrArchiveStagingCorrupt = errors.New("archive staging corrupt")

// ErrArchiveStagingMissing reports an absent staging namespace or object
// observed under the relevant storage exclusion, after checking the volume.
// Path identity changes and storage availability errors are not absence proof.
var ErrArchiveStagingMissing = errors.New("archive staging missing")
var ErrArchiveStagingOffset = errors.New("archive staging offset mismatch")

// ArchiveStaging is an exclusive Session-scoped capability. A caller must
// recheck admission after acquisition and hold it through all I/O and publication.
// Open freezes mutations on the capability until Close, so validation and
// publication read the same bytes. An open body must close before the handle.
type ArchiveStaging interface {
	Create(context.Context, string) error
	// AdoptEmpty accepts an already-created empty staging object only after the
	// caller has established that adoption is permitted for this file identity.
	// It does not create, truncate or replace the object.
	AdoptEmpty(context.Context, string) error
	Observe(context.Context, string, int64) (int64, error)
	Append(context.Context, string, int64, int64, []byte) (int64, error)
	Open(context.Context, string, int64) (Object, error)
	Publish(context.Context, string, int64, string, string) (FileInfo, error)
	Delete(context.Context, string) error
	Close() error
}

type ArchiveStagingBackend interface {
	AcquireArchiveStaging(context.Context, sessionarchive.Namespace, bool) (ArchiveStaging, error)
}

// ArchiveStagingChunkSizer selects the maximum read and append size for a
// streaming upload. Backends without it use the local 512 KiB policy.
type ArchiveStagingChunkSizer interface {
	ArchiveStagingChunkSize() int
}

// ArchiveStagingReader reads a stopped, paired backup without mutating it.
type ArchiveStagingReader interface {
	OpenArchiveStaging(context.Context, sessionarchive.Namespace, string) (Object, error)
}

// ArchiveStagingPath is reserved for a single raw staging file per file ID.
func ArchiveStagingPath(namespace sessionarchive.Namespace, fileID string) (string, error) {
	if err := namespace.Validate(); err != nil {
		return "", fmt.Errorf("%w: %w", ErrInvalidAddress, err)
	}
	id, err := uuid.Parse(fileID)
	if err != nil || id == uuid.Nil || id.String() != fileID {
		return "", fmt.Errorf("%w: invalid archive staging file ID", ErrInvalidAddress)
	}
	return namespace.Directory() + "/.staging/" + fileID, nil
}
