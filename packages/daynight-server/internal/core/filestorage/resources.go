package filestorage

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
)

// ResourceStorage exposes typed, complete namespace deletion and volume facts.
// The owner must close durable admission, cancel and join all leases before
// final sweep. Successful deletion includes its directory fsync barrier.
type ResourceStorage interface {
	DeleteSessionResources(context.Context, sessionresource.Namespace) error
	ResourceSpace(context.Context) (int64, int64, error)
}

// UploadStorage removes the exact upload namespace, including publications
// whose metadata transaction never committed. The caller must first close
// upload admission and join every writer. Success includes the parent fsync.
type UploadStorage interface {
	DeleteSessionUpload(context.Context, sessionresource.Namespace, string) error
}
