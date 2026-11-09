package filestorage

import (
	"context"
	"errors"
	"io"
)

// TryAcquireMediaLease shares the exact key used by MediaLeaseGate. Busy means
// the existing owner may still perform I/O; no durable lease may be reclaimed.
func TryAcquireMediaLease(ctx context.Context, gates ResidencyGate, key string) (io.Closer, error) {
	if key == "" {
		return nil, errors.New("empty media lease key")
	}
	return gates.TryAcquireResidency(ctx, "media-lease/"+key)
}
