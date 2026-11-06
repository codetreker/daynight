package oauth

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type cleanupDAO struct {
	store.AuthorizationDAO
	cursor   int
	pending  []store.OAuthAuthorization
	retained int
	fail     string
	calls    map[string]int
}

var errCleanup = errors.New("cleanup failure")

func (d *cleanupDAO) failure(name string) error {
	d.calls[name]++
	if d.fail == name || d.fail == fmt.Sprintf("%s:%d", name, d.calls[name]) {
		return errCleanup
	}
	return nil
}
func (d *cleanupDAO) LockAuthorizationCapacity(context.Context) error { return d.failure("lock") }
func (d *cleanupDAO) AuthorizationCleanupCursor(context.Context) (int, error) {
	return d.cursor, d.failure("cursor")
}
func (d *cleanupDAO) SetAuthorizationCleanupCursor(_ context.Context, next int) error {
	if err := d.failure("set cursor"); err != nil {
		return err
	}
	d.cursor = next
	return nil
}
func (d *cleanupDAO) ExpiredAuthorizations(_ context.Context, _ time.Time, limit int) ([]store.OAuthAuthorization, error) {
	if err := d.failure("select"); err != nil {
		return nil, err
	}
	var result []store.OAuthAuthorization
	for _, a := range d.pending {
		if a.Status == "pending" && len(result) < limit {
			result = append(result, a)
		}
	}
	return result, nil
}
func (d *cleanupDAO) FreshTime(_ context.Context, now time.Time) (time.Time, error) {
	return now, d.failure("clock")
}
func (d *cleanupDAO) UpdateAuthorization(_ context.Context, a store.OAuthAuthorization) error {
	if err := d.failure("update"); err != nil {
		return err
	}
	for i := range d.pending {
		if d.pending[i].ID == a.ID {
			d.pending[i] = a
			return nil
		}
	}
	return errors.New("missing authorization")
}
func (d *cleanupDAO) DeleteRetainedAuthorizations(_ context.Context, _ time.Time, limit int) (int, error) {
	if err := d.failure("delete"); err != nil {
		return 0, err
	}
	n := min(d.retained, limit)
	d.retained -= n
	return n, nil
}
func cleanupFixture(now time.Time, pending, retained int) *cleanupDAO {
	d := &cleanupDAO{retained: retained, calls: map[string]int{}}
	for i := range pending {
		d.pending = append(d.pending, store.OAuthAuthorization{ID: fmt.Sprint(i), Status: "pending", State: "opaque", StatePresent: true, ExpiresAt: now.Add(-time.Minute)})
	}
	return d
}

// The caller's transaction restores all DAO changes if the batch fails.
func cleanupTransaction(d *cleanupDAO, now time.Time, limit int) (int, error) {
	cursor, retained := d.cursor, d.retained
	pending := append([]store.OAuthAuthorization(nil), d.pending...)
	n, err := PruneAuthorizationBatch(context.Background(), d, now, limit)
	if err != nil {
		d.cursor, d.retained, d.pending = cursor, retained, pending
	}
	return n, err
}

func TestAuthorizationCleanupFairnessAndSpareQuota(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	d := cleanupFixture(now, 3, 3)
	for i := 0; i < 2; i++ {
		if n, err := cleanupTransaction(d, now, 1); err != nil || n != 1 {
			t.Fatalf("batch %d: %d %v", i, n, err)
		}
	}
	if d.cursor != 0 || d.pending[0].Status != "expired" || d.pending[0].State != "" || d.pending[0].StatePresent || d.retained != 2 {
		t.Fatalf("one-row batches not fair: %+v", d)
	}
	d = cleanupFixture(now, 4, 1)
	if n, err := cleanupTransaction(d, now, 3); err != nil || n != 3 || d.retained != 0 || d.pending[1].Status != "expired" || d.pending[2].Status != "pending" || d.cursor != 1 {
		t.Fatalf("odd quota: n=%d err=%v state=%+v", n, err, d)
	}
	if n, err := cleanupTransaction(d, now, 3); err != nil || n != 2 || d.pending[3].Status != "expired" {
		t.Fatalf("spare quota: n=%d err=%v state=%+v", n, err, d)
	}
	d = cleanupFixture(now, 1, 1)
	if n, err := cleanupTransaction(d, now, 0); err != nil || n != 0 || d.calls["lock"] != 1 || d.calls["cursor"] != 0 {
		t.Fatalf("zero limit: %d %v %+v", n, err, d.calls)
	}
}

func TestAuthorizationCleanupFailuresPreserveTransaction(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, stage := range []string{"lock", "cursor", "set cursor", "select", "clock", "update", "delete", "select:2"} {
		t.Run(stage, func(t *testing.T) {
			d := cleanupFixture(now, 1, 1)
			limit := 2
			if stage == "delete" {
				d.cursor, limit = 1, 1
			}
			if stage == "select:2" {
				d.pending = nil
				d.retained = 0
			}
			beforeCursor, beforeRetained := d.cursor, d.retained
			beforePending := append([]store.OAuthAuthorization(nil), d.pending...)
			d.fail = stage
			_, err := cleanupTransaction(d, now, limit)
			if !errors.Is(err, errCleanup) || d.cursor != beforeCursor || d.retained != beforeRetained || !reflect.DeepEqual(d.pending, beforePending) {
				t.Fatalf("failure %s did not roll back: %v %+v", stage, err, d)
			}
		})
	}
}
