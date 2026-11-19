// Package redis implements file storage gates using expiring Redis keys.
package redis

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	redisclient "github.com/redis/go-redis/v9"
)

const (
	keyPrefix     = "dn:storage-gate:"
	leaseTTL      = 30 * time.Second
	renewInterval = 10 * time.Second
	retryInterval = 50 * time.Millisecond
)

// Gates shares exclusion with every server using the same Redis database.
// The application owns the client and closes it after all gate users stop.
type Gates struct {
	client        *redisclient.Client
	ttl           time.Duration
	renewInterval time.Duration
}

var _ filestorage.Gates = (*Gates)(nil)

func New(client *redisclient.Client) *Gates {
	return &Gates{client: client, ttl: leaseTTL, renewInterval: renewInterval}
}

func (g *Gates) TryAcquireResidency(ctx context.Context, key string) (io.Closer, error) {
	if key == "" {
		return nil, errors.New("empty residency gate key")
	}
	return g.tryAcquire(ctx, residencyKey(key))
}

func residencyKey(key string) string {
	return fmt.Sprintf("%sresidency:%x", keyPrefix, sha256.Sum256([]byte(key)))
}

func (g *Gates) AcquireGate(ctx context.Context, domain filestorage.GateDomain, key string) (io.Closer, error) {
	var redisKey string
	switch domain {
	case filestorage.TargetGate, filestorage.PrivateGate:
		if key == "" {
			return nil, errors.New("empty storage gate key")
		}
		redisKey = fmt.Sprintf("%s%s:%03d", keyPrefix, domain, sha256.Sum256([]byte(key))[0])
	case filestorage.MediaLeaseGate:
		mediaKey, err := filestorage.MediaLeaseKey(key)
		if err != nil {
			return nil, err
		}
		redisKey = residencyKey(mediaKey)
	default:
		return nil, fmt.Errorf("invalid storage gate domain %q", domain)
	}
	for {
		permit, err := g.tryAcquire(ctx, redisKey)
		if !errors.Is(err, filestorage.ErrGateBusy) {
			return permit, err
		}
		timer := time.NewTimer(retryInterval)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return nil, context.Cause(ctx)
		}
	}
}

func (g *Gates) tryAcquire(ctx context.Context, key string) (io.Closer, error) {
	if err := context.Cause(ctx); err != nil {
		return nil, err
	}
	token := rand.Text()
	started := time.Now()
	acquired, err := g.client.SetNX(ctx, key, token, g.ttl).Result()
	if err != nil {
		// The command may have succeeded before its response was lost. Its
		// expiry bounds the lifetime of that unconfirmed lease.
		return nil, fmt.Errorf("acquire Redis storage gate: %w", err)
	}
	if !acquired {
		if err := context.Cause(ctx); err != nil {
			return nil, err
		}
		return nil, filestorage.ErrGateBusy
	}
	permit := g.newLease(key, token, started.Add(g.ttl))
	if err := errors.Join(context.Cause(ctx), permit.check()); err != nil {
		return nil, errors.Join(err, permit.Close())
	}
	return permit, nil
}
