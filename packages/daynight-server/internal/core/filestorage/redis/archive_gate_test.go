package redis

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/google/uuid"
	redisclient "github.com/redis/go-redis/v9"
)

func archiveTestPermit(t *testing.T, g *Gates, owner, session string, limit int, cleanup bool) *lease {
	t.Helper()
	p := acquireForTest(t, func() (io.Closer, error) { return g.TryAcquireArchive(t.Context(), owner, session, limit, cleanup) })
	t.Cleanup(func() { _ = p.Close() })
	return p
}

func archiveBusy(t *testing.T, g *Gates, owner, session string, limit int, cleanup bool) {
	t.Helper()
	if p, err := g.TryAcquireArchive(t.Context(), owner, session, limit, cleanup); !errors.Is(err, filestorage.ErrGateBusy) {
		if p != nil {
			_ = p.Close()
		}
		t.Fatalf("expected archive gate busy: %v", err)
	}
}

func TestArchiveGateCrossInstanceAndLegacyProtocol(t *testing.T) {
	a, b := redisFixture(t)
	owner, one, two, three := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	key, err := filestorage.ArchiveGateKey(owner, one, 2, false)
	if err != nil {
		t.Fatal(err)
	}
	legacy := acquireForTest(t, func() (io.Closer, error) { return a.TryAcquireResidency(t.Context(), key) })
	t.Cleanup(func() { _ = legacy.Close() })
	archiveBusy(t, b, owner, one, 2, false)
	archiveBusy(t, b, owner, "", 2, true)
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}
	p := archiveTestPermit(t, a, owner, one, 2, false)
	archiveBusy(t, b, owner, two, 1, false)
	q := archiveTestPermit(t, b, owner, two, 2, false)
	archiveBusy(t, b, owner, one, 2, false)
	archiveBusy(t, b, owner, three, 2, false)
	archiveBusy(t, b, owner, "", 2, true)
	if _, err := a.TryAcquireResidency(t.Context(), key); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("old SET NX accepted new record: %v", err)
	}
	for _, script := range []struct {
		name string
		args []any
	}{
		{"renew", []any{legacy.token, a.ttl.Milliseconds()}}, {"release", []any{legacy.token}},
	} {
		var result int
		if script.name == "renew" {
			result, err = renewLease.Run(t.Context(), a.client, []string{p.key}, script.args...).Int()
		} else {
			result, err = releaseLease.Run(t.Context(), a.client, []string{p.key}, script.args...).Int()
		}
		if err != nil || result != 0 {
			t.Fatalf("old %s touched new records: %d %v", script.name, result, err)
		}
	}
	if err := p.VerifyGate(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	archiveBusy(t, b, owner, "", 2, true)
	if err := q.Close(); err != nil {
		t.Fatal(err)
	}
	if exists, err := a.client.Exists(t.Context(), p.key).Result(); err != nil || exists != 0 {
		t.Fatalf("last close must delete key: %d %v", exists, err)
	}
	clean := archiveTestPermit(t, b, owner, "", 2, true)
	archiveBusy(t, a, owner, three, 2, false)
	if err := clean.Close(); err != nil {
		t.Fatal(err)
	}
	_ = archiveTestPermit(t, a, owner, three, 2, false)
}

func TestArchiveGateExpiryAndStaleRelease(t *testing.T) {
	a, b := redisFixture(t)
	a.ttl, a.renewInterval = 150*time.Millisecond, time.Hour
	owner, one, two := uuid.NewString(), uuid.NewString(), uuid.NewString()
	p := archiveTestPermit(t, a, owner, one, 2, false)
	q := archiveTestPermit(t, b, owner, two, 2, false)
	if ttl, err := b.client.PTTL(t.Context(), p.key).Result(); err != nil || ttl < time.Second {
		t.Fatalf("key TTL did not retain later permit: %v %v", ttl, err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	timer := time.NewTimer(200 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
		t.Fatal("timed out waiting for lease expiry")
	}
	replacement := archiveTestPermit(t, b, owner, one, 2, false)
	if got, err := archiveGate.Run(ctx, a.client, []string{p.key}, "renew", p.token, "", 0, a.ttl.Milliseconds(), "false").Int(); err != nil || got != 0 {
		t.Fatalf("expired token renewed: %d %v", got, err)
	}
	if err := p.Close(); !errors.Is(err, filestorage.ErrGateLost) {
		t.Fatalf("stale close: %v", err)
	}
	if err := replacement.VerifyGate(ctx); err != nil {
		t.Fatalf("stale close invalidated replacement: %v", err)
	}
	if err := q.VerifyGate(ctx); err != nil {
		t.Fatalf("other Session lost: %v", err)
	}
	archiveBusy(t, b, owner, "", 2, true)
}

func TestArchiveGateRejectsMalformedRecordAndCancelsLostLease(t *testing.T) {
	a, b := redisFixture(t)
	owner, id := uuid.NewString(), uuid.NewString()
	p := archiveTestPermit(t, a, owner, id, 2, false)
	protected, stop := p.GateContext(t.Context())
	defer stop()
	for _, bad := range []string{"dn-archive-v1:invalid", "dn-archive-v2:[]", "dn-archive-v1:[{}]"} {
		if err := b.client.Set(t.Context(), p.key, bad, time.Second).Err(); err != nil {
			t.Fatal(err)
		}
		archiveBusy(t, b, owner, uuid.NewString(), 2, false)
		value, err := b.client.Get(t.Context(), p.key).Result()
		if err != nil || value != bad {
			t.Fatalf("invalid record was changed: %q %v", value, err)
		}
	}
	if err := p.VerifyGate(t.Context()); !errors.Is(err, filestorage.ErrGateLost) {
		t.Fatalf("lost permit verified: %v", err)
	}
	if !errors.Is(context.Cause(protected), filestorage.ErrGateLost) {
		t.Fatalf("lost permit did not cancel: %v", context.Cause(protected))
	}
	if err := p.Close(); !errors.Is(err, filestorage.ErrGateLost) {
		t.Fatalf("lost permit release: %v", err)
	}
	value, err := b.client.Get(t.Context(), p.key).Result()
	if err != nil || !strings.HasPrefix(value, "dn-archive-v1:") {
		t.Fatalf("lost release changed replacement: %q %v", value, err)
	}
	if err := b.client.Del(t.Context(), p.key).Err(); err != nil {
		t.Fatal(err)
	}
}

func TestArchiveGateRenewsLivePermitAndExpiresDisconnectedPeer(t *testing.T) {
	a, b := redisFixture(t)
	a.ttl, a.renewInterval = 300*time.Millisecond, 30*time.Millisecond
	b.ttl, b.renewInterval = 150*time.Millisecond, time.Hour
	owner, one, two := uuid.NewString(), uuid.NewString(), uuid.NewString()
	p := archiveTestPermit(t, a, owner, one, 2, false)
	q := archiveTestPermit(t, b, owner, two, 2, false)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	// The live permit must survive longer than its original TTL while the
	// disconnected peer expires independently from the same owner record.
	timer := time.NewTimer(450 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
		t.Fatal("timed out waiting for renewal")
	}
	if err := p.VerifyGate(ctx); err != nil {
		t.Fatalf("live permit failed to renew: %v", err)
	}
	if ttl, err := a.client.PTTL(ctx, p.key).Result(); err != nil || ttl <= 0 {
		t.Fatalf("renewed record lost TTL: %v %v", ttl, err)
	}
	if err := q.VerifyGate(ctx); !errors.Is(err, filestorage.ErrGateLost) {
		t.Fatalf("expired peer still valid: %v", err)
	}
	r := archiveTestPermit(t, a, owner, two, 2, false)
	if err := q.Close(); !errors.Is(err, filestorage.ErrGateLost) {
		t.Fatalf("expired release: %v", err)
	}
	if err := p.VerifyGate(ctx); err != nil {
		t.Fatalf("expired release affected live permit: %v", err)
	}
	if err := r.VerifyGate(ctx); err != nil {
		t.Fatalf("expired release affected replacement: %v", err)
	}
}

func TestArchiveGateConnectionLossCancelsOperation(t *testing.T) {
	a, b := redisFixture(t)
	client := redisclient.NewClient(a.client.Options())
	g := New(client)
	g.ttl, g.renewInterval = 2*time.Second, 30*time.Millisecond
	owner, id := uuid.NewString(), uuid.NewString()
	p := archiveTestPermit(t, g, owner, id, 2, false)
	t.Cleanup(func() { _ = b.client.Del(context.Background(), p.key).Err() })
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	protected, stop := p.GateContext(ctx)
	defer stop()
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-protected.Done():
	case <-ctx.Done():
		t.Fatal("connection loss did not cancel operation")
	}
	if !errors.Is(context.Cause(protected), filestorage.ErrGateLost) || !errors.Is(context.Cause(protected), redisclient.ErrClosed) {
		t.Fatalf("connection loss cause: %v", context.Cause(protected))
	}
	if err := p.Close(); !errors.Is(err, filestorage.ErrGateLost) || !errors.Is(err, redisclient.ErrClosed) {
		t.Fatalf("connection loss release: %v", err)
	}
}

func TestArchiveGateCanceledAfterGrantReleasesOnlyItsPermit(t *testing.T) {
	a, b := redisFixture(t)
	owner, one, two := uuid.NewString(), uuid.NewString(), uuid.NewString()
	other := archiveTestPermit(t, b, owner, one, 2, false)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	a.client.AddHook(afterCommand{run: func(cmd redisclient.Cmder) {
		if cmd.Name() == "eval" || cmd.Name() == "evalsha" {
			cancel()
		}
	}})
	if p, err := a.TryAcquireArchive(ctx, owner, two, 2, false); p != nil || !errors.Is(err, context.Canceled) {
		if p != nil {
			_ = p.Close()
		}
		t.Fatalf("canceled grant: %v", err)
	}
	if err := other.VerifyGate(t.Context()); err != nil {
		t.Fatalf("canceled grant affected peer: %v", err)
	}
	_ = archiveTestPermit(t, b, owner, two, 2, false)
}

func TestArchiveGateAtomicConcurrentAdmission(t *testing.T) {
	a, b := redisFixture(t)
	owner, one, two := uuid.NewString(), uuid.NewString(), uuid.NewString()
	start := make(chan struct{})
	type result struct {
		session string
		cleanup bool
		permit  io.Closer
		err     error
	}
	results := make(chan result, 17)
	var wg sync.WaitGroup
	for i := range 17 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			g, id, cleanup := a, one, i == 16
			if i%2 == 1 {
				g, id = b, two
			}
			if cleanup {
				id = ""
			}
			p, err := g.TryAcquireArchive(t.Context(), owner, id, 2, cleanup)
			results <- result{id, cleanup, p, err}
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)
	seen := make(map[string]bool)
	cleanups := 0
	for r := range results {
		if r.err != nil {
			if !errors.Is(r.err, filestorage.ErrGateBusy) {
				t.Errorf("concurrent admission: %v", r.err)
			}
			continue
		}
		defer r.permit.Close()
		if r.cleanup {
			cleanups++
		} else if seen[r.session] {
			t.Errorf("same Session admitted twice")
		} else {
			seen[r.session] = true
		}
	}
	if cleanups > 1 || (cleanups > 0 && len(seen) > 0) || (cleanups == 0 && len(seen) != 2) {
		t.Fatalf("inconsistent grants: %d cleanup, %d Sessions", cleanups, len(seen))
	}
}

func TestArchiveGateRejectsInvalidCanceledAndUnavailable(t *testing.T) {
	client := redisclient.NewClient(&redisclient.Options{Addr: "unused"})
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	g := New(client)
	owner, id := uuid.NewString(), uuid.NewString()
	if p, err := g.TryAcquireArchive(t.Context(), owner, "invalid", 1, false); p != nil || err == nil {
		t.Fatalf("invalid Session accepted: %v, %v", p, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if p, err := g.TryAcquireArchive(ctx, owner, id, 1, false); p != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled acquisition: %v, %v", p, err)
	}
	if p, err := g.TryAcquireArchive(t.Context(), owner, id, 1, false); p != nil || !errors.Is(err, redisclient.ErrClosed) {
		t.Fatalf("unavailable Redis acquisition: %v, %v", p, err)
	}
}

func TestArchiveGateCancellationAfterBusyResult(t *testing.T) {
	a, b := redisFixture(t)
	owner, one, two := uuid.NewString(), uuid.NewString(), uuid.NewString()
	p := archiveTestPermit(t, a, owner, one, 1, false)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	b.client.AddHook(afterCommand{run: func(cmd redisclient.Cmder) {
		if cmd.Name() == "eval" || cmd.Name() == "evalsha" {
			cancel()
		}
	}})
	if got, err := b.TryAcquireArchive(ctx, owner, two, 1, false); got != nil || !errors.Is(err, context.Canceled) {
		if got != nil {
			_ = got.Close()
		}
		t.Fatalf("canceled busy result: %v, %v", got, err)
	}
	if err := p.VerifyGate(t.Context()); err != nil {
		t.Fatalf("busy attempt changed the held permit: %v", err)
	}
}
