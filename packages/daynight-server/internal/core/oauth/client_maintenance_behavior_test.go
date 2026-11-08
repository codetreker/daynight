package oauth

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type retentionDAO struct {
	store.OAuthClientDAO
	store.CredentialFamilyDAO
	clients map[string]store.OAuthClient
	active  map[string]bool
	batches [][]string
	limits  []int
	deleted []string
	locked  bool
	stage   string
	failure error
	now     time.Time
	t       *testing.T
}

func (d *retentionDAO) LockClientCapacity(context.Context) error {
	d.locked = true
	if d.stage == "lock" {
		return d.failure
	}
	return nil
}

func (d *retentionDAO) ExpiredClients(_ context.Context, now time.Time, limit int) ([]string, error) {
	if !d.locked || !now.Equal(d.now) {
		d.t.Fatal("candidate query lost capacity lock or cutoff")
	}
	d.limits = append(d.limits, limit)
	if d.stage == "expired" {
		return nil, d.failure
	}
	if len(d.batches) == 0 {
		return nil, nil
	}
	batch := d.batches[0]
	d.batches = d.batches[1:]
	return batch, nil
}

func (d *retentionDAO) Client(_ context.Context, id string, lock bool) (store.OAuthClient, error) {
	if !lock {
		d.t.Fatal("candidate read was not locked")
	}
	if d.stage == "client" {
		return store.OAuthClient{}, d.failure
	}
	c, ok := d.clients[id]
	if !ok {
		return store.OAuthClient{}, model.ErrNotFound
	}
	return c, nil
}

func (d *retentionDAO) FreshTime(_ context.Context, now time.Time) (time.Time, error) {
	if !now.Equal(d.now) {
		d.t.Fatal("fresh time lost supplied cutoff")
	}
	if d.stage == "time" {
		return time.Time{}, d.failure
	}
	return d.now, nil
}

func (d *retentionDAO) ActiveClientReferences(_ context.Context, id string, now time.Time) (bool, error) {
	if !now.Equal(d.now) {
		d.t.Fatal("reference read lost fresh time")
	}
	if d.stage == "references" {
		return false, d.failure
	}
	return d.active[id], nil
}

func (d *retentionDAO) DeleteClient(_ context.Context, id string) error {
	if d.stage == "delete" {
		return d.failure
	}
	d.deleted = append(d.deleted, id)
	return nil
}

type retentionScope struct{ dao *retentionDAO }

func (s retentionScope) OAuthClientDAO() store.OAuthClientDAO           { return s.dao }
func (s retentionScope) CredentialFamilyDAO() store.CredentialFamilyDAO { return s.dao }

type retentionWriter struct {
	dao          *retentionDAO
	transactions int
}

func (w *retentionWriter) WriteOAuthClients(ctx context.Context, fn func(store.OAuthClientScope) error) (store.Completion, error) {
	w.transactions++
	w.dao.locked = false
	if err := fn(retentionScope{dao: w.dao}); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func expiredClient(id string, now time.Time) store.OAuthClient {
	return store.OAuthClient{ID: id, ExpiresAt: now, LastUsedAt: now.Add(-7 * 24 * time.Hour)}
}

func TestPruneClientsRechecksRetentionAndActiveReferences(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	future := expiredClient("future", now)
	future.ExpiresAt = now.Add(time.Second)
	recent := expiredClient("recent", now)
	recent.LastUsedAt = now.Add(-7*24*time.Hour + time.Second)
	dao := &retentionDAO{t: t, now: now, clients: map[string]store.OAuthClient{
		"future": future, "recent": recent, "active": expiredClient("active", now), "expired": expiredClient("expired", now),
	}, active: map[string]bool{"active": true}, batches: [][]string{{"missing", "future", "recent", "active", "expired"}}}
	w := &retentionWriter{dao: dao}
	n, err := PruneClients(t.Context(), w, 20, now)
	if err != nil || n != 1 || !reflect.DeepEqual(dao.deleted, []string{"expired"}) || w.transactions != 1 || !reflect.DeepEqual(dao.limits, []int{20}) {
		t.Fatalf("cleanup = %d, %v; deleted=%v transactions=%d limits=%v", n, err, dao.deleted, w.transactions, dao.limits)
	}
}

func TestPruneClientsUsesRemainingCandidateBudgetAcrossTransactions(t *testing.T) {
	now := time.Now()
	first := make([]string, 100)
	for i := range first {
		first[i] = fmt.Sprintf("gone-%d", i)
	}
	dao := &retentionDAO{t: t, now: now, clients: map[string]store.OAuthClient{"last": expiredClient("last", now)}, batches: [][]string{first, {"last"}}}
	w := &retentionWriter{dao: dao}
	n, err := PruneClients(t.Context(), w, 101, now)
	if err != nil || n != 1 || w.transactions != 2 || !reflect.DeepEqual(dao.limits, []int{100, 1}) || !reflect.DeepEqual(dao.deleted, []string{"last"}) {
		t.Fatalf("cleanup = %d, %v; transactions=%d limits=%v deleted=%v", n, err, w.transactions, dao.limits, dao.deleted)
	}
}

func TestPruneClientsPropagatesCandidateFailures(t *testing.T) {
	for _, stage := range []string{"lock", "expired", "client", "time", "references", "delete"} {
		t.Run(stage, func(t *testing.T) {
			now := time.Now()
			failure := errors.New(stage + " failed")
			dao := &retentionDAO{t: t, now: now, stage: stage, failure: failure, clients: map[string]store.OAuthClient{"expired": expiredClient("expired", now)}, batches: [][]string{{"expired"}}}
			n, err := PruneClients(t.Context(), &retentionWriter{dao: dao}, 1, now)
			if err != failure || n != 0 || len(dao.deleted) != 0 {
				t.Fatalf("cleanup = %d, %v; deleted=%v", n, err, dao.deleted)
			}
		})
	}
}
