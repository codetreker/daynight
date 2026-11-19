package local

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

// Keep the former lock directory reserved so existing control files cannot be
// addressed as ordinary storage objects.
const gateDirectory = ".daynight-gates"

func (s *Storage) AcquireGate(ctx context.Context, domain filestorage.GateDomain, key string) (io.Closer, error) {
	if s.closed.Load() {
		return nil, os.ErrClosed
	}
	permit, err := s.gates.AcquireGate(ctx, domain, key)
	if err != nil {
		return nil, err
	}
	if s.closed.Load() {
		return nil, errors.Join(os.ErrClosed, permit.Close())
	}
	return permit, nil
}

func (s *Storage) TryAcquireResidency(ctx context.Context, key string) (io.Closer, error) {
	if s.closed.Load() {
		return nil, os.ErrClosed
	}
	permit, err := s.gates.TryAcquireResidency(ctx, key)
	if err != nil {
		return nil, err
	}
	if s.closed.Load() {
		return nil, errors.Join(os.ErrClosed, permit.Close())
	}
	return permit, nil
}

type standaloneGates struct {
	root string
}

type standaloneKey struct {
	root      string
	domain    filestorage.GateDomain
	stripe    byte
	residency string
}

// Handles opened on the same resolved root in this process share these permits.
// Entries live only while a permit is held, even when its storage handle closes.
var standalonePermits = struct {
	sync.Mutex
	held map[standaloneKey]*standalonePermit
}{held: make(map[standaloneKey]*standalonePermit)}

type standalonePermit struct {
	key  standaloneKey
	done chan struct{}
	once sync.Once
}

func (p *standalonePermit) Close() error {
	p.once.Do(func() {
		standalonePermits.Lock()
		defer standalonePermits.Unlock()
		delete(standalonePermits.held, p.key)
		close(p.done)
	})
	return nil
}

func (g standaloneGates) AcquireGate(ctx context.Context, domain filestorage.GateDomain, key string) (io.Closer, error) {
	if key == "" {
		return nil, errors.New("empty storage gate key")
	}
	switch domain {
	case filestorage.TargetGate, filestorage.PrivateGate:
		stripe := sha256.Sum256([]byte(key))[0]
		return acquireStandalone(ctx, standaloneKey{root: g.root, domain: domain, stripe: stripe}, true)
	case filestorage.MediaLeaseGate:
		leaseKey, err := filestorage.MediaLeaseKey(key)
		if err != nil {
			return nil, err
		}
		return acquireStandalone(ctx, standaloneKey{root: g.root, residency: leaseKey}, true)
	default:
		return nil, fmt.Errorf("invalid storage gate domain %q", domain)
	}
}

func (g standaloneGates) TryAcquireResidency(ctx context.Context, key string) (io.Closer, error) {
	if key == "" {
		return nil, errors.New("empty residency gate key")
	}
	return acquireStandalone(ctx, standaloneKey{root: g.root, residency: key}, false)
}

func acquireStandalone(ctx context.Context, key standaloneKey, wait bool) (io.Closer, error) {
	for {
		standalonePermits.Lock()
		if err := context.Cause(ctx); err != nil {
			standalonePermits.Unlock()
			return nil, err
		}
		held := standalonePermits.held[key]
		if held == nil {
			permit := &standalonePermit{key: key, done: make(chan struct{})}
			standalonePermits.held[key] = permit
			standalonePermits.Unlock()
			return permit, nil
		}
		standalonePermits.Unlock()
		if !wait {
			return nil, filestorage.ErrGateBusy
		}
		select {
		case <-held.done:
		case <-ctx.Done():
			return nil, context.Cause(ctx)
		}
	}
}
