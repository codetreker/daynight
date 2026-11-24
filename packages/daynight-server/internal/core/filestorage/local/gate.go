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

func (s *Storage) TryAcquireArchive(ctx context.Context, owner, session string, limit int, cleanup bool) (io.Closer, error) {
	if s.closed.Load() {
		return nil, os.ErrClosed
	}
	permit, err := s.gates.TryAcquireArchive(ctx, owner, session, limit, cleanup)
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

// NewStandaloneGates returns process-local gates shared by handles with the
// same identity. The identity identifies one storage namespace and must not
// contain credentials. These gates do not coordinate across processes.
func NewStandaloneGates(identity string) (filestorage.Gates, error) {
	if identity == "" {
		return nil, errors.New("storage gate identity is required")
	}
	// A filesystem root cannot contain NUL, so this namespace is disjoint from
	// the resolved roots used by local storage handles.
	return standaloneGates{root: "\x00" + identity}, nil
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
	held     map[standaloneKey]*standalonePermit
	archives map[standaloneKey]*standaloneArchives
}{held: make(map[standaloneKey]*standalonePermit), archives: make(map[standaloneKey]*standaloneArchives)}

type standaloneArchives struct {
	sessions map[string]bool
	cleanup  bool
	done     chan struct{}
}

type standaloneArchivePermit struct {
	key     standaloneKey
	session string
	cleanup bool
	once    sync.Once
}

func (p *standaloneArchivePermit) Close() error {
	p.once.Do(func() {
		standalonePermits.Lock()
		defer standalonePermits.Unlock()
		state := standalonePermits.archives[p.key]
		if p.cleanup {
			state.cleanup = false
		} else {
			delete(state.sessions, p.session)
		}
		if !state.cleanup && len(state.sessions) == 0 {
			delete(standalonePermits.archives, p.key)
			close(state.done)
		}
	})
	return nil
}

func (g standaloneGates) TryAcquireArchive(ctx context.Context, owner, session string, limit int, cleanup bool) (io.Closer, error) {
	key, err := filestorage.ArchiveGateKey(owner, session, limit, cleanup)
	if err != nil {
		return nil, err
	}
	k := standaloneKey{root: g.root, residency: key}
	standalonePermits.Lock()
	defer standalonePermits.Unlock()
	if err := context.Cause(ctx); err != nil {
		return nil, err
	}
	state := standalonePermits.archives[k]
	if standalonePermits.held[k] != nil || (state != nil && (state.cleanup || cleanup || len(state.sessions) >= limit || state.sessions[session])) {
		return nil, filestorage.ErrGateBusy
	}
	if state == nil {
		state = &standaloneArchives{sessions: make(map[string]bool), done: make(chan struct{})}
		standalonePermits.archives[k] = state
	}
	if cleanup {
		state.cleanup = true
	} else {
		state.sessions[session] = true
	}
	return &standaloneArchivePermit{key: k, session: session, cleanup: cleanup}, nil
}

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
		archives := standalonePermits.archives[key]
		if held == nil && archives == nil {
			permit := &standalonePermit{key: key, done: make(chan struct{})}
			standalonePermits.held[key] = permit
			standalonePermits.Unlock()
			return permit, nil
		}
		standalonePermits.Unlock()
		if !wait {
			return nil, filestorage.ErrGateBusy
		}
		done := (<-chan struct{})(nil)
		if held != nil {
			done = held.done
		} else {
			done = archives.done
		}
		select {
		case <-done:
		case <-ctx.Done():
			return nil, context.Cause(ctx)
		}
	}
}
