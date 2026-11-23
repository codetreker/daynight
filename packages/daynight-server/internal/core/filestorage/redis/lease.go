package redis

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	redisclient "github.com/redis/go-redis/v9"
)

const releaseTimeout = time.Second

var (
	renewLease = redisclient.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`)
	releaseLease = redisclient.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`)
)

type lease struct {
	gates       *Gates
	key         string
	token       string
	lifetime    context.Context
	endLifetime context.CancelCauseFunc
	stopRenewal context.CancelFunc
	renewalDone chan struct{}
	validity    sync.Mutex
	validUntil  time.Time
	closeOnce   sync.Once
	closeErr    error
	archive     bool
}

func (g *Gates) newLease(key, token string, validUntil time.Time, archive bool) *lease {
	lifetime, endLifetime := context.WithCancelCause(context.Background())
	renewal, stopRenewal := context.WithCancel(lifetime)
	p := &lease{
		gates: g, key: key, token: token, lifetime: lifetime, endLifetime: endLifetime,
		stopRenewal: stopRenewal, renewalDone: make(chan struct{}), validUntil: validUntil, archive: archive,
	}
	go p.renew(renewal)
	return p
}

func (p *lease) renew(ctx context.Context) {
	defer close(p.renewalDone)
	renewLead := max(0, p.gates.ttl-p.gates.renewInterval)
	timer := time.NewTimer(time.Until(p.validUntil.Add(-renewLead)))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if err := p.check(); err != nil {
			return
		}
		p.validity.Lock()
		deadline := p.validUntil
		p.validity.Unlock()
		started := time.Now()
		callCtx, cancel := context.WithDeadline(ctx, deadline)
		var renewed int
		var err error
		if p.archive {
			renewed, err = archiveGate.Run(callCtx, p.gates.client, []string{p.key}, "renew", p.token, "", 0, p.gates.ttl.Milliseconds(), "false").Int()
		} else {
			renewed, err = renewLease.Run(callCtx, p.gates.client, []string{p.key}, p.token, p.gates.ttl.Milliseconds()).Int()
		}
		cancel()
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			p.endLifetime(fmt.Errorf("%w: renew Redis storage gate: %w", filestorage.ErrGateLost, err))
			return
		}
		if renewed != 1 {
			p.endLifetime(filestorage.ErrGateLost)
			return
		}
		p.validity.Lock()
		// A paused process cannot extend its local validity with a late reply.
		if !time.Now().Before(p.validUntil) {
			p.endLifetime(filestorage.ErrGateLost)
			p.validity.Unlock()
			return
		}
		p.validUntil = started.Add(p.gates.ttl)
		timer.Reset(time.Until(p.validUntil.Add(-renewLead)))
		p.validity.Unlock()
	}
}

func (p *lease) check() error {
	p.validity.Lock()
	defer p.validity.Unlock()
	if !time.Now().Before(p.validUntil) {
		p.endLifetime(filestorage.ErrGateLost)
	}
	return context.Cause(p.lifetime)
}

func (p *lease) CheckGate() error { return p.check() }

func (p *lease) VerifyGate(ctx context.Context) error {
	if err := p.check(); err != nil {
		return err
	}
	var matches bool
	var err error
	if p.archive {
		var found int
		found, err = archiveGate.Run(ctx, p.gates.client, []string{p.key}, "verify", p.token, "", 0, p.gates.ttl.Milliseconds(), "false").Int()
		matches = found == 1
	} else {
		var token string
		token, err = p.gates.client.Get(ctx, p.key).Result()
		matches = token == p.token
	}
	if ctx.Err() != nil {
		return context.Cause(ctx)
	}
	if errors.Is(err, redisclient.Nil) || (err == nil && !matches) {
		p.endLifetime(filestorage.ErrGateLost)
	} else if err != nil {
		p.endLifetime(fmt.Errorf("%w: verify Redis storage gate: %w", filestorage.ErrGateLost, err))
	}
	return p.check()
}

type leaseOperationContext struct {
	context.Context
	lease  *lease
	cancel context.CancelCauseFunc
}

func (c leaseOperationContext) Err() error {
	c.cancelIfLost()
	return c.Context.Err()
}

func (c leaseOperationContext) Value(key any) any {
	// context.Cause reads the underlying cancellation through Value.
	c.cancelIfLost()
	return c.Context.Value(key)
}

func (c leaseOperationContext) cancelIfLost() {
	// After a process pause, an operation can resume before the renewal
	// goroutine observes expiry.
	if err := c.lease.check(); err != nil {
		c.cancel(err)
	}
}

func (p *lease) GateContext(parent context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancelCause(parent)
	stop := context.AfterFunc(p.lifetime, func() { cancel(context.Cause(p.lifetime)) })
	if err := p.check(); err != nil {
		cancel(err)
	}
	return leaseOperationContext{Context: ctx, lease: p, cancel: cancel}, func() {
		stop()
		cancel(context.Canceled)
	}
}

func (p *lease) Close() error {
	p.closeOnce.Do(func() {
		p.stopRenewal()
		<-p.renewalDone
		lost := p.check()
		p.endLifetime(context.Canceled)
		ctx, cancel := context.WithTimeout(context.Background(), releaseTimeout)
		defer cancel()
		var released int
		var err error
		if p.archive {
			released, err = archiveGate.Run(ctx, p.gates.client, []string{p.key}, "release", p.token, "", 0, p.gates.ttl.Milliseconds(), "false").Int()
		} else {
			released, err = releaseLease.Run(ctx, p.gates.client, []string{p.key}, p.token).Int()
		}
		if err != nil {
			err = fmt.Errorf("release Redis storage gate: %w", err)
		} else if released != 1 && lost == nil {
			err = filestorage.ErrGateLost
		}
		p.closeErr = errors.Join(lost, err)
	})
	return p.closeErr
}
