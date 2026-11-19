package redis

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	redisclient "github.com/redis/go-redis/v9"
)

func redisFixture(t *testing.T) (*Gates, *Gates) {
	t.Helper()
	rawURL := os.Getenv("DAYNIGHT_TEST_REDIS_URL")
	if rawURL == "" {
		t.Fatal("DAYNIGHT_TEST_REDIS_URL is required for Redis storage gate tests")
	}
	opts, err := redisclient.ParseURL(rawURL)
	if err != nil {
		t.Fatal("invalid Redis test URL")
	}
	opts.MaxRetries = -1
	opts.ContextTimeoutEnabled = true
	opts.ReadTimeout = time.Second
	opts.WriteTimeout = time.Second
	a, b := New(redisclient.NewClient(opts)), New(redisclient.NewClient(opts))
	t.Cleanup(func() {
		if err := errors.Join(a.client.Close(), b.client.Close()); err != nil {
			t.Error(err)
		}
	})
	for _, gates := range []*Gates{a, b} {
		gates.ttl = 3 * time.Second
		gates.renewInterval = 50 * time.Millisecond
	}
	return a, b
}

func acquireForTest(t *testing.T, acquire func() (io.Closer, error)) *lease {
	t.Helper()
	permit, err := acquire()
	if err != nil {
		t.Fatal(err)
	}
	return permit.(*lease)
}

func closeForTest(t *testing.T, permit io.Closer) {
	t.Helper()
	if err := permit.Close(); err != nil {
		t.Error(err)
	}
}

func TestStorageGateContention(t *testing.T) {
	a, b := redisFixture(t)
	ctx := t.Context()
	p := acquireForTest(t, func() (io.Closer, error) {
		return a.AcquireGate(ctx, filestorage.TargetGate, t.Name())
	})
	defer closeForTest(t, p)
	other := acquireForTest(t, func() (io.Closer, error) {
		return b.AcquireGate(ctx, filestorage.PrivateGate, t.Name())
	})
	defer closeForTest(t, other)
	waitCtx, cancel := context.WithTimeout(ctx, 120*time.Millisecond)
	defer cancel()
	if _, err := b.AcquireGate(waitCtx, filestorage.TargetGate, t.Name()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want blocked acquisition deadline, got %v", err)
	}
	closeForTest(t, p)
	next := acquireForTest(t, func() (io.Closer, error) {
		return b.AcquireGate(ctx, filestorage.TargetGate, t.Name())
	})
	defer closeForTest(t, next)
	if p.token == next.token {
		t.Fatal("ownership token reused")
	}
	if _, err := b.AcquireGate(ctx, "invalid", t.Name()); err == nil {
		t.Fatal("invalid domain accepted")
	}
	if _, err := b.AcquireGate(ctx, filestorage.TargetGate, ""); err == nil {
		t.Fatal("empty target key accepted")
	}
}

func TestMediaLeaseUsesResidencyKey(t *testing.T) {
	a, b := redisFixture(t)
	ctx := t.Context()
	p := acquireForTest(t, func() (io.Closer, error) {
		return a.AcquireGate(ctx, filestorage.MediaLeaseGate, t.Name())
	})
	defer closeForTest(t, p)
	if _, err := filestorage.TryAcquireMediaLease(ctx, b, t.Name()); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("want immediate contention for the same media lease, got %v", err)
	}
	other := acquireForTest(t, func() (io.Closer, error) {
		return b.TryAcquireResidency(ctx, t.Name())
	})
	defer closeForTest(t, other)
	if _, err := b.TryAcquireResidency(ctx, ""); err == nil {
		t.Fatal("empty residency key accepted")
	}
}

func TestLeaseRenewsAfterAcquisitionContextEnds(t *testing.T) {
	a, b := redisFixture(t)
	acquireCtx, cancelAcquire := context.WithCancel(t.Context())
	p := acquireForTest(t, func() (io.Closer, error) {
		return a.TryAcquireResidency(acquireCtx, t.Name())
	})
	defer closeForTest(t, p)
	cancelAcquire()
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	protected, stop := p.GateContext(ctx)
	defer stop()
	if err := b.client.PExpire(ctx, p.key, time.Second).Err(); err != nil {
		t.Fatal(err)
	}
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		ttl, err := b.client.PTTL(ctx, p.key).Result()
		if err != nil {
			t.Fatal(err)
		}
		if ttl > time.Second {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("lease did not renew")
		case <-ticker.C:
		}
	}
	if err := protected.Err(); err != nil {
		t.Fatal(err)
	}
	if _, err := b.TryAcquireResidency(ctx, t.Name()); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("want renewed lease to remain busy, got %v", err)
	}
}

func TestExpiredLeaseCannotReleaseNewOwner(t *testing.T) {
	a, b := redisFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	a.ttl = 100 * time.Millisecond
	a.renewInterval = time.Hour
	p := acquireForTest(t, func() (io.Closer, error) {
		return a.AcquireGate(ctx, filestorage.TargetGate, t.Name())
	})
	defer p.Close()
	protected, stop := p.GateContext(ctx)
	defer stop()
	next := acquireForTest(t, func() (io.Closer, error) {
		return b.AcquireGate(ctx, filestorage.TargetGate, t.Name())
	})
	defer closeForTest(t, next)
	if protected.Err() != context.Canceled || !errors.Is(context.Cause(protected), filestorage.ErrGateLost) {
		t.Fatalf("want the previous operation canceled on expiry, got %v", context.Cause(protected))
	}
	if err := p.Close(); !errors.Is(err, filestorage.ErrGateLost) {
		t.Fatalf("want stale close to report lease loss, got %v", err)
	}
	if token, err := b.client.Get(ctx, next.key).Result(); err != nil || token != next.token {
		t.Fatalf("stale close removed the new owner: %v", err)
	}
}

func TestLeaseLossCancelsOperation(t *testing.T) {
	a, b := redisFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	p := acquireForTest(t, func() (io.Closer, error) {
		return a.TryAcquireResidency(ctx, t.Name())
	})
	defer p.Close()
	protected, stop := p.GateContext(ctx)
	defer stop()
	if err := b.client.Set(ctx, p.key, "replacement", a.ttl).Err(); err != nil {
		t.Fatal(err)
	}
	defer b.client.Del(context.WithoutCancel(ctx), p.key)
	select {
	case <-protected.Done():
	case <-ctx.Done():
		t.Fatal("operation outlived its lease")
	}
	if !errors.Is(context.Cause(protected), filestorage.ErrGateLost) {
		t.Fatalf("want lease loss cause, got %v", context.Cause(protected))
	}
	if err := p.Close(); !errors.Is(err, filestorage.ErrGateLost) {
		t.Fatalf("want release to preserve lease loss, got %v", err)
	}
	if token, err := b.client.Get(ctx, p.key).Result(); err != nil || token != "replacement" {
		t.Fatalf("lost owner changed its replacement: %v", err)
	}
}

func TestUnavailableRedisFailsAcquisition(t *testing.T) {
	client := redisclient.NewClient(&redisclient.Options{Addr: "unused"})
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	g := New(client)
	if p, err := g.TryAcquireResidency(t.Context(), t.Name()); p != nil || !errors.Is(err, redisclient.ErrClosed) {
		t.Fatalf("want backend failure to deny acquisition, got permit %v, error %v", p, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if p, err := g.TryAcquireResidency(ctx, t.Name()); p != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("want canceled acquisition, got permit %v, error %v", p, err)
	}
}

func TestResidencyGateUsesFullHash(t *testing.T) {
	a, b := redisFixture(t)
	ctx := t.Context()
	key := t.Name()
	firstByte := sha256.Sum256([]byte(key))[0]
	var otherKey string
	for i := 0; ; i++ {
		otherKey = fmt.Sprintf("%s/%d", key, i)
		if sha256.Sum256([]byte(otherKey))[0] == firstByte {
			break
		}
	}
	p := acquireForTest(t, func() (io.Closer, error) {
		return a.TryAcquireResidency(ctx, key)
	})
	defer closeForTest(t, p)
	other := acquireForTest(t, func() (io.Closer, error) {
		return b.TryAcquireResidency(ctx, otherKey)
	})
	defer closeForTest(t, other)
}

func TestRenewalBackendFailureCancelsOperation(t *testing.T) {
	a, b := redisFixture(t)
	client := redisclient.NewClient(a.client.Options())
	gates := New(client)
	gates.renewInterval = a.renewInterval
	gates.ttl = a.ttl
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	p := acquireForTest(t, func() (io.Closer, error) {
		return gates.TryAcquireResidency(ctx, t.Name())
	})
	defer p.Close()
	defer b.client.Del(context.WithoutCancel(ctx), p.key)
	protected, stop := p.GateContext(ctx)
	defer stop()
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-protected.Done():
	case <-ctx.Done():
		t.Fatal("operation outlived failure to renew")
	}
	cause := context.Cause(protected)
	if !errors.Is(cause, filestorage.ErrGateLost) || !errors.Is(cause, redisclient.ErrClosed) {
		t.Fatalf("want lost lease and backend error, got %v", cause)
	}
	if err := p.Close(); !errors.Is(err, filestorage.ErrGateLost) || !errors.Is(err, redisclient.ErrClosed) {
		t.Fatalf("want release to preserve both causes, got %v", err)
	}
}

type afterCommand struct {
	run func(redisclient.Cmder)
}

func (h afterCommand) DialHook(next redisclient.DialHook) redisclient.DialHook {
	return next
}

func (h afterCommand) ProcessHook(next redisclient.ProcessHook) redisclient.ProcessHook {
	return func(ctx context.Context, cmd redisclient.Cmder) error {
		err := next(ctx, cmd)
		if err == nil {
			h.run(cmd)
		}
		return err
	}
}

func (h afterCommand) ProcessPipelineHook(next redisclient.ProcessPipelineHook) redisclient.ProcessPipelineHook {
	return next
}

func TestCancellationAfterRedisGrantReleasesLease(t *testing.T) {
	a, b := redisFixture(t)
	acquireCtx, cancel := context.WithCancel(t.Context())
	defer cancel()
	a.client.AddHook(afterCommand{run: func(cmd redisclient.Cmder) {
		if cmd.Name() == "set" {
			cancel()
		}
	}})
	if permit, err := a.TryAcquireResidency(acquireCtx, t.Name()); permit != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("want canceled acquisition after Redis grant, got permit %v, error %v", permit, err)
	}
	next := acquireForTest(t, func() (io.Closer, error) {
		return b.TryAcquireResidency(t.Context(), t.Name())
	})
	defer closeForTest(t, next)
}

func TestVerifyGatesRejectsReplacedOuterLeaseBeforeRenewal(t *testing.T) {
	a, b := redisFixture(t)
	a.renewInterval = time.Hour
	ctx := t.Context()
	outer := acquireForTest(t, func() (io.Closer, error) {
		return a.TryAcquireResidency(ctx, t.Name()+"/outer")
	})
	defer outer.Close()
	inner := acquireForTest(t, func() (io.Closer, error) {
		return b.TryAcquireResidency(ctx, t.Name()+"/inner")
	})
	defer closeForTest(t, inner)
	protected, stopOuter := filestorage.GateContext(ctx, outer)
	defer stopOuter()
	protected, stopInner := filestorage.GateContext(protected, inner)
	defer stopInner()
	child, cancel := context.WithCancel(protected)
	defer cancel()
	if err := b.client.Set(ctx, outer.key, "successor", a.ttl).Err(); err != nil {
		t.Fatal(err)
	}
	defer b.client.Del(ctx, outer.key)
	if err := filestorage.VerifyGates(child); !errors.Is(err, filestorage.ErrGateLost) {
		t.Fatalf("checked mutation could use old outer lease: %v", err)
	}
	if got, err := b.client.Get(ctx, outer.key).Result(); err != nil || got != "successor" {
		t.Fatalf("verification must preserve the successor: %q, %v", got, err)
	}
}

func TestRedisVerificationFailureRevokesLease(t *testing.T) {
	server, _ := redisFixture(t)
	client := redisclient.NewClient(server.client.Options())
	gates := New(client)
	p := acquireForTest(t, func() (io.Closer, error) {
		return gates.TryAcquireResidency(t.Context(), t.Name())
	})
	defer server.client.Del(t.Context(), p.key)
	defer p.Close()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := p.VerifyGate(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("verify with canceled context: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	if err := p.VerifyGate(t.Context()); !errors.Is(err, filestorage.ErrGateLost) || !errors.Is(err, redisclient.ErrClosed) {
		t.Fatalf("verify after client closed: %v", err)
	}
	if err := p.VerifyGate(t.Context()); !errors.Is(err, filestorage.ErrGateLost) {
		t.Fatalf("recheck revoked lease: %v", err)
	}
}
