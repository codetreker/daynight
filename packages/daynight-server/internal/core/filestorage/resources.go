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
