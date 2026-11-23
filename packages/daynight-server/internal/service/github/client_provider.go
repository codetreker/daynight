package github

import (
	"container/list"
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

var (
	ErrClientProviderClosed = errors.New("github client provider is closed")
	ErrCredentialChanged    = errors.New("github app credential version changed")
)

type providerApp struct {
	version int64
	deleted bool
	pending int
	entries map[int64]*providerEntry
}

type providerEntry struct {
	app     string
	version int64
	client  *remote.Client
	refs    int
	idle    *list.Element
}

// ClientProvider shares clients by App resource and credential version. Callers
// retain the release function until every operation using that client has exited.
// A successful Acquire is not an authorization or an execution fence.
type ClientProvider struct {
	reader        store.GitHubAppCredentialReader
	ctx           context.Context
	cancel        context.CancelFunc
	mu            sync.Mutex
	apps          map[string]*providerApp
	idle          list.List
	pending, refs int
	closing       bool
	drained       chan struct{}
}

const clientProviderIdleLimit = 64

func NewClientProvider(reader store.GitHubAppCredentialReader) (*ClientProvider, error) {
	if reader == nil {
		return nil, errors.New("github client provider requires a credential reader")
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &ClientProvider{reader: reader, ctx: ctx, cancel: cancel, apps: make(map[string]*providerApp), drained: make(chan struct{})}, nil
}

// Acquire checks the current snapshot even on a cache hit. The returned client
// must not be used after release. External authorization is checked separately.
func (p *ClientProvider) Acquire(ctx context.Context, appID string, version int64) (*remote.Client, func(), error) {
	if ctx == nil || appID == "" || version <= 0 {
		return nil, nil, errors.New("invalid github client acquisition")
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	p.mu.Lock()
	if p.closing {
		p.mu.Unlock()
		return nil, nil, ErrClientProviderClosed
	}
	a := p.apps[appID]
	if a == nil {
		a = &providerApp{entries: make(map[int64]*providerEntry)}
		p.apps[appID] = a
	}
	a.pending++
	p.pending++
	p.mu.Unlock()

	readCtx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(p.ctx, cancel)
	snapshot, err := p.reader.Credentials(readCtx, appID)
	stop()
	cancel()

	p.mu.Lock()
	defer p.mu.Unlock()
	defer func() {
		a.pending--
		p.pending--
		p.forgetApp(appID, a)
		p.checkDrained()
	}()
	if p.closing {
		return nil, nil, ErrClientProviderClosed
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if errors.Is(err, model.ErrNotFound) {
		a.deleted = true
		for _, e := range a.entries {
			if e.refs == 0 {
				p.remove(e, a)
			}
		}
	}
	if err != nil {
		return nil, nil, err
	}
	if a.deleted {
		return nil, nil, model.ErrNotFound
	}
	if snapshot.AppResourceID != appID || snapshot.CredentialVersion <= 0 || snapshot.GitHubAppID <= 0 || len(snapshot.PrivateKeyPEM) == 0 {
		return nil, nil, errors.New("invalid github app credential snapshot")
	}
	// Keep the newest observed version while any overlapping read or client
	// exists, so an older delayed read cannot resurrect a retired client.
	if snapshot.CredentialVersion > a.version {
		a.version = snapshot.CredentialVersion
		for _, e := range a.entries {
			if e.version < a.version && e.refs == 0 {
				p.remove(e, a)
			}
		}
	}
	if version != snapshot.CredentialVersion || version != a.version {
		return nil, nil, ErrCredentialChanged
	}
	e := a.entries[version]
	if e == nil {
		key, err := config.ParsePrivateKey(snapshot.PrivateKeyPEM)
		if err != nil {
			return nil, nil, err
		}
		client, err := remote.NewClient(snapshot.GitHubAppID, key)
		if err != nil {
			return nil, nil, err
		}
		e = &providerEntry{app: appID, version: version, client: client}
		a.entries[version] = e
	} else if e.idle != nil {
		p.idle.Remove(e.idle)
		e.idle = nil
	}
	e.refs++
	p.refs++
	var once sync.Once
	release := func() { once.Do(func() { p.release(e) }) }
	return e.client, release, nil
}

func (p *ClientProvider) release(e *providerEntry) {
	p.mu.Lock()
	defer p.mu.Unlock()
	a := p.apps[e.app]
	e.refs--
	p.refs--
	if e.refs == 0 {
		if p.closing || a.deleted || e.version != a.version {
			p.remove(e, a)
		} else {
			e.idle = p.idle.PushFront(e)
			for p.idle.Len() > clientProviderIdleLimit {
				old := p.idle.Back().Value.(*providerEntry)
				oldApp := p.apps[old.app]
				p.remove(old, oldApp)
				p.forgetApp(old.app, oldApp)
			}
		}
	}
	p.forgetApp(e.app, a)
	p.checkDrained()
}

func (p *ClientProvider) remove(e *providerEntry, a *providerApp) {
	if e.idle != nil {
		p.idle.Remove(e.idle)
		e.idle = nil
	}
	delete(a.entries, e.version)
	e.client.CloseIdleConnections()
}

func (p *ClientProvider) forgetApp(id string, a *providerApp) {
	if a.pending == 0 && len(a.entries) == 0 {
		delete(p.apps, id)
	}
}

func (p *ClientProvider) checkDrained() {
	if p.closing && p.pending == 0 && p.refs == 0 {
		select {
		case <-p.drained:
		default:
			close(p.drained)
		}
	}
}

// Close stops acquisitions, cancels credential reads and waits for all borrowed
// clients to be released. A deadline leaves active clients intact; release will
// close them after use and a later Close may wait again.
func (p *ClientProvider) Close(ctx context.Context) error {
	if ctx == nil {
		return errors.New("missing github client provider close context")
	}
	p.mu.Lock()
	if !p.closing {
		p.closing = true
		p.cancel()
		for p.idle.Len() > 0 {
			e := p.idle.Back().Value.(*providerEntry)
			a := p.apps[e.app]
			p.remove(e, a)
			p.forgetApp(e.app, a)
		}
		p.checkDrained()
	}
	drained := p.drained
	p.mu.Unlock()
	select {
	case <-drained:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("drain github client provider: %w", ctx.Err())
	}
}
