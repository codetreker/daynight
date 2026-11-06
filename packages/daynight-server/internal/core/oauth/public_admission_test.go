package oauth

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type rateDAO struct {
	store.IdentityDAO
	counts   map[string]int
	pruneErr error
}

func (d *rateDAO) PruneDeviceRates(context.Context, time.Time) error { return d.pruneErr }
func (d *rateDAO) IncrementDeviceRate(_ context.Context, b model.DeviceRateBucket, _ time.Time) (int, error) {
	d.counts[string(b.Hash)]++
	return d.counts[string(b.Hash)], nil
}

type rateScope struct {
	store.IdentityScope
	dao store.IdentityDAO
}

func (s rateScope) IdentityDAO() store.IdentityDAO { return s.dao }

type rateWriter struct {
	dao     *rateDAO
	commits int
	fail    error
	outcome store.TransactionOutcome
}

func (w *rateWriter) WriteIdentity(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
	err := fn(rateScope{dao: w.dao})
	if err == nil {
		err = w.fail
	}
	if err == nil {
		w.commits++
	}
	outcome := w.outcome
	if outcome == "" {
		outcome = store.TransactionCommitted
	}
	return store.Completion{Outcome: outcome}, err
}
func TestPublicAdmissionCommitsRejectedAttempts(t *testing.T) {
	d := &rateDAO{counts: map[string]int{}}
	w := &rateWriter{dao: d}
	a := PublicAdmission{Writer: w, Now: func() time.Time { return time.Unix(1, 0) }}
	for i := 0; i < 11; i++ {
		allowed, err := a.Take(context.Background(), "register", "source", "")
		if err != nil || allowed != (i < 10) {
			t.Fatalf("attempt %d: %v %v", i, allowed, err)
		}
	}
	if w.commits != 11 {
		t.Fatalf("commits=%d", w.commits)
	}
	if _, err := a.Take(context.Background(), "bad", "source", ""); err == nil {
		t.Fatal("invalid kind accepted")
	}
	if _, err := a.Take(context.Background(), "token", "", ""); err == nil {
		t.Fatal("missing source accepted")
	}
	w.fail = errors.New("commit failed")
	if allowed, err := a.Take(context.Background(), "start", "source", ""); allowed || err == nil {
		t.Fatal("commit error must not admit")
	}
}
func TestPublicAdmissionGlobalLimitPrecedesSourceAllocation(t *testing.T) {
	d := &rateDAO{counts: map[string]int{}}
	a := PublicAdmission{Writer: &rateWriter{dao: d}}
	for i := 0; i < 100; i++ {
		allowed, err := a.Take(context.Background(), "register", string(rune(i+1)), "")
		if !allowed || err != nil {
			t.Fatalf("%d %v %v", i, allowed, err)
		}
	}
	n := len(d.counts)
	allowed, err := a.Take(context.Background(), "register", "new", "")
	if allowed || err != nil || len(d.counts) != n {
		t.Fatalf("global budget did not stop allocation: %v %v %d %d", allowed, err, n, len(d.counts))
	}
}

func TestTokenAdmissionTwoPhases(t *testing.T) {
	ctx := context.Background()
	d := &rateDAO{counts: map[string]int{}}
	w := &rateWriter{dao: d}
	a := PublicAdmission{Writer: w}
	permit, allowed, err := a.TakeToken(ctx, "source")
	if err != nil || !allowed || permit == nil {
		t.Fatalf("initial: %v %v %v", permit, allowed, err)
	}
	global := string(secret.Hash("oauth:token:global"))
	source := string(secret.Hash("oauth:token:source:source"))
	client := string(secret.Hash("oauth:token:client:verified"))
	if len(d.counts) != 2 || d.counts[global] != 1 || d.counts[source] != 1 {
		t.Fatalf("initial buckets: %v", d.counts)
	}
	if ok, err := permit.TakeClient(ctx, "verified"); !ok || err != nil {
		t.Fatalf("client phase: %v %v", ok, err)
	}
	if d.counts[global] != 1 || d.counts[source] != 1 || d.counts[client] != 1 {
		t.Fatalf("double charged: %v", d.counts)
	}
	if ok, err := permit.TakeClient(ctx, "verified"); ok || err == nil || d.counts[client] != 1 {
		t.Fatalf("duplicate: %v %v", ok, err)
	}
	if _, err := a.Take(ctx, "token", "source", "verified"); err == nil {
		t.Fatal("direct token admission accepted")
	}
	if _, err := a.Take(ctx, "start", "source", "unverified"); err == nil {
		t.Fatal("unverified client allocated")
	}
}

func TestTokenPermitSingleUseAcrossCopiesAndConcurrentCalls(t *testing.T) {
	ctx := context.Background()
	d := &rateDAO{counts: map[string]int{}}
	w := &rateWriter{dao: d}
	p, _, err := (PublicAdmission{Writer: w}).TakeToken(ctx, "source")
	if err != nil {
		t.Fatal(err)
	}
	copyPermit := *p
	var wg sync.WaitGroup
	var mu sync.Mutex
	success, failed := 0, 0
	for i := range 30 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			target := p
			if i%2 == 0 {
				target = &copyPermit
			}
			ok, err := target.TakeClient(ctx, "validated")
			mu.Lock()
			defer mu.Unlock()
			if ok && err == nil {
				success++
			} else if !ok && err != nil {
				failed++
			}
		}(i)
	}
	wg.Wait()
	if success != 1 || failed != 29 || w.commits != 2 {
		t.Fatalf("success %d failed %d commits %d", success, failed, w.commits)
	}
}

func TestTokenPermitFailureCannotBeReplayed(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name    string
		fail    error
		outcome store.TransactionOutcome
		id      string
	}{
		{name: "empty", id: ""},
		{name: "write failure", id: "client", fail: errors.New("write failed")},
		{name: "unknown", id: "client", outcome: store.TransactionUnknown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &rateDAO{counts: map[string]int{}}
			w := &rateWriter{dao: d}
			p, _, err := (PublicAdmission{Writer: w}).TakeToken(ctx, "source")
			if err != nil {
				t.Fatal(err)
			}
			w.fail, w.outcome = tc.fail, tc.outcome
			if ok, err := p.TakeClient(ctx, tc.id); ok || err == nil {
				t.Fatalf("first attempt: %v %v", ok, err)
			}
			before := len(d.counts)
			w.fail, w.outcome = nil, ""
			if ok, err := p.TakeClient(ctx, "client"); ok || err == nil || len(d.counts) != before {
				t.Fatalf("replay: %v %v", ok, err)
			}
		})
	}
	var missing *TokenPermit
	if _, err := missing.TakeClient(ctx, "client"); err == nil {
		t.Fatal("nil permit accepted")
	}
}

func TestTokenClientLimitAndUnverifiedRequests(t *testing.T) {
	ctx := context.Background()
	d := &rateDAO{counts: map[string]int{}}
	w := &rateWriter{dao: d}
	a := PublicAdmission{Writer: w}
	for i := 0; i < 241; i++ {
		p, ok, err := a.TakeToken(ctx, fmt.Sprintf("source-%d", i/120))
		if !ok || err != nil || p == nil {
			t.Fatalf("first phase %d: %v %v", i, ok, err)
		}
		ok, err = p.TakeClient(ctx, "client")
		if err != nil || ok != (i < 240) {
			t.Fatalf("client phase %d: %v %v", i, ok, err)
		}
	}
	p, ok, err := a.TakeToken(ctx, "unverified-source")
	if !ok || err != nil || p == nil {
		t.Fatal("initial admission failed")
	}
	before := len(d.counts)
	if ok, err := p.TakeClient(ctx, ""); ok || err == nil || len(d.counts) != before {
		t.Fatal("unverified client persisted")
	}
}
