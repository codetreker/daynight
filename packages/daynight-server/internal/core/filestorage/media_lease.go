package filestorage

import (
	"context"
	"errors"
	"io"
)

// TryAcquireMediaLease shares the exact key used by MediaLeaseGate. Busy means
// the existing owner may still perform I/O; no durable lease may be reclaimed.
func TryAcquireMediaLease(ctx context.Context, gates ResidencyGate, key string) (io.Closer, error) {
	leaseKey, err := MediaLeaseKey(key)
	if err != nil {
		return nil, err
	}
	return gates.TryAcquireResidency(ctx, leaseKey)
}

// MediaLeaseKey puts blocking and nonblocking media permits in the same namespace.
func MediaLeaseKey(key string) (string, error) {
	if key == "" {
		return "", errors.New("empty media lease key")
	}
	return "media-lease/" + key, nil
}
