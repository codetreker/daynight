package oauth

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type lifecycleFake struct {
	store.GrantLifecycleDAO
	now         time.Time
	failures    map[string]error
	calls       map[string]int
	grant       store.OAuthGrant
	refresh     store.OAuthRefresh
	accessGrant string
	outcome     store.TransactionOutcome
	pruneCounts []int
	pruneLimits []int
}

func (f *lifecycleFake) failure(name string) error {
	f.calls[name]++
	return f.failures[fmt.Sprintf("%s:%d", name, f.calls[name])]
}
func (f *lifecycleFake) WriteGrantLifecycle(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
	if e := f.failure("transaction"); e != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, e
	}
	err := fn(f)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	if f.outcome != "" {
		return store.Completion{Outcome: f.outcome}, nil
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func (f *lifecycleFake) Refresh(_ context.Context, _ []byte, _ bool) (store.OAuthRefresh, error) {
	return f.refresh, f.failure("refresh")
}
func (f *lifecycleFake) InspectGrant(_ context.Context, _ string, _ bool) (store.OAuthGrant, error) {
	return f.grant, f.failure("grant")
}
func (f *lifecycleFake) AccessGrant(_ context.Context, _ []byte) (string, error) {
	return f.accessGrant, f.failure("access")
}
func (f *lifecycleFake) FreshTime(_ context.Context, _ time.Time) (time.Time, error) {
	return f.now, f.failure("time")
}
func (f *lifecycleFake) RevokeFamily(_ context.Context, _ string, _ time.Time) (bool, error) {
	return true, f.failure("revoke")
}
func (f *lifecycleFake) RotateRefresh(_ context.Context, _ store.OAuthRotation) error {
	return f.failure("rotate")
}
func (f *lifecycleFake) OwnerGrants(_ context.Context, _ string) ([]store.OAuthGrant, error) {
	return []store.OAuthGrant{f.grant}, f.failure("list")
}
func (f *lifecycleFake) PruneCredentials(_ context.Context, _ time.Time, limit int) (int, error) {
	f.pruneLimits = append(f.pruneLimits, limit)
	err := f.failure("prune")
	if len(f.pruneCounts) == 0 {
		return 0, err
	}
	n := f.pruneCounts[0]
	f.pruneCounts = f.pruneCounts[1:]
	return n, err
}
func newLifecycleFake() *lifecycleFake {
	now := time.Now().UTC()
	id := uuid.NewString()
	return &lifecycleFake{now: now, failures: map[string]error{}, calls: map[string]int{}, grant: store.OAuthGrant{ID: id, UserID: uuid.NewString(), ClientID: "client", Resource: "https://example.test/mcp", Scope: Scope, ExpiresAt: now.Add(time.Hour)}, refresh: store.OAuthRefresh{GrantID: id, ClientID: "client", ExpiresAt: now.Add(time.Hour)}, accessGrant: id}
}
func TestRotationFailuresDoNotReleaseSecrets(t *testing.T) {
	boom := errors.New("injected failure")
	token := secret.Random(RefreshPrefix)
	for _, step := range []string{"refresh:1", "grant:1", "refresh:2", "grant:2", "refresh:3", "time:1", "rotate:1"} {
		t.Run(step, func(t *testing.T) {
			f := newLifecycleFake()
			f.failures[step] = boom
			result, err := NewGrantLifecycle(f).Rotate(t.Context(), token, "client", f.grant.Resource, func(context.Context, string) error { return nil })
			if !errors.Is(err, boom) || result.AccessToken != "" || result.RefreshToken != "" {
				t.Fatalf("failure leaked token: %+v %v", result, err)
			}
		})
	}
	for _, step := range []string{"refresh:1", "grant:1", "refresh:2", "grant:2", "refresh:3"} {
		t.Run("missing "+step, func(t *testing.T) {
			f := newLifecycleFake()
			f.failures[step] = model.ErrNotFound
			_, err := NewGrantLifecycle(f).Rotate(t.Context(), token, "client", f.grant.Resource, func(context.Context, string) error { return nil })
			if !errors.Is(err, ErrInvalidGrant) {
				t.Fatalf("missing: %v", err)
			}
		})
	}
	f := newLifecycleFake()
	f.outcome = store.TransactionUnknown
	if result, err := NewGrantLifecycle(f).Rotate(t.Context(), token, "client", f.grant.Resource, func(context.Context, string) error { return nil }); !errors.Is(err, ErrAuthorizationUnknown) || result.AccessToken != "" {
		t.Fatalf("unknown read: %+v %v", result, err)
	}
	f = newLifecycleFake()
	used := f.now
	f.refresh.ConsumedAt = &used
	f.failures["revoke:1"] = boom
	if _, err := NewGrantLifecycle(f).Rotate(t.Context(), token, "client", f.grant.Resource, func(context.Context, string) error { return nil }); !errors.Is(err, boom) {
		t.Fatalf("replay failure: %v", err)
	}
	if _, err := NewGrantLifecycle(f).Rotate(t.Context(), "invalid", "client", f.grant.Resource, nil); !errors.Is(err, ErrInvalidGrant) {
		t.Fatal(err)
	}
	f = newLifecycleFake()
	f.grant.RevokedAt = &used
	if _, err := NewGrantLifecycle(f).Rotate(t.Context(), token, "client", f.grant.Resource, func(context.Context, string) error { return nil }); !errors.Is(err, ErrInvalidGrant) {
		t.Fatal(err)
	}
}
func TestPublicRevocationFailuresAndUnknownTokens(t *testing.T) {
	boom := errors.New("injected failure")
	for _, tc := range []struct{ token, step string }{
		{secret.Random(RefreshPrefix), "refresh:1"}, {secret.Random(RefreshPrefix), "grant:1"}, {secret.Random(RefreshPrefix), "refresh:2"}, {secret.Random(RefreshPrefix), "time:1"}, {secret.Random(RefreshPrefix), "revoke:1"},
		{secret.Random(model.OAuthAccessPrefix), "access:1"}, {secret.Random(model.OAuthAccessPrefix), "access:2"},
	} {
		f := newLifecycleFake()
		f.failures[tc.step] = boom
		if err := NewGrantLifecycle(f).RevokePublic(t.Context(), tc.token, "client"); !errors.Is(err, boom) {
			t.Fatalf("%s: %v", tc.step, err)
		}
	}
	for _, tc := range []struct{ token, step string }{{secret.Random(RefreshPrefix), "refresh:1"}, {secret.Random(RefreshPrefix), "grant:1"}, {secret.Random(RefreshPrefix), "refresh:2"}, {secret.Random(model.OAuthAccessPrefix), "access:1"}, {secret.Random(model.OAuthAccessPrefix), "access:2"}} {
		f := newLifecycleFake()
		f.failures[tc.step] = model.ErrNotFound
		if err := NewGrantLifecycle(f).RevokePublic(t.Context(), tc.token, "client"); err != nil {
			t.Fatalf("unknown %s: %v", tc.step, err)
		}
	}
	f := newLifecycleFake()
	f.accessGrant = uuid.NewString()
	if err := NewGrantLifecycle(f).RevokePublic(t.Context(), secret.Random(model.OAuthAccessPrefix), "client"); err != nil || f.calls["revoke"] != 0 {
		t.Fatalf("changed binding: %v", err)
	}
	f = newLifecycleFake()
	f.refresh.ClientID = "other"
	if err := NewGrantLifecycle(f).RevokePublic(t.Context(), secret.Random(RefreshPrefix), "client"); err != nil || f.calls["revoke"] != 0 {
		t.Fatalf("changed binding: %v", err)
	}
	if err := NewGrantLifecycle(f).RevokePublic(t.Context(), "malformed", "client"); err != nil {
		t.Fatal(err)
	}
}
func TestLifecycleOwnerAndMaintenanceFailures(t *testing.T) {
	boom := errors.New("injected failure")
	f := newLifecycleFake()
	lifecycle := NewGrantLifecycle(f)
	if _, err := lifecycle.ListOwnerGrants(t.Context(), "bad"); err == nil {
		t.Fatal("invalid owner accepted")
	}
	f.failures["list:1"] = boom
	if _, err := lifecycle.ListOwnerGrants(t.Context(), f.grant.UserID); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	if _, err := lifecycle.RevokeOwnerGrant(t.Context(), "bad", f.grant.ID); err == nil {
		t.Fatal("invalid owner accepted")
	}
	f.failures["grant:1"] = boom
	if _, err := lifecycle.RevokeOwnerGrant(t.Context(), f.grant.UserID, f.grant.ID); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	f = newLifecycleFake()
	f.failures["time:1"] = boom
	if _, err := NewGrantLifecycle(f).RevokeOwnerGrant(t.Context(), f.grant.UserID, f.grant.ID); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	f = newLifecycleFake()
	f.failures["revoke:1"] = boom
	if _, err := NewGrantLifecycle(f).RevokeOwnerGrant(t.Context(), f.grant.UserID, f.grant.ID); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	f = newLifecycleFake()
	f.failures["prune:1"] = boom
	if _, err := NewGrantLifecycle(f).PruneCredentials(t.Context(), 100); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	if _, err := NewGrantLifecycle(f).PruneCredentials(t.Context(), -1); err == nil {
		t.Fatal("invalid budget accepted")
	}
	now := time.Now()
	if minTime(now, now.Add(time.Second)) != now || minTime(now.Add(time.Second), now) != now {
		t.Fatal("minimum time mismatch")
	}
}

func TestCredentialPruneBatchAndLimit(t *testing.T) {
	f := newLifecycleFake()
	f.pruneCounts = []int{100, 10}
	n, err := NewGrantLifecycle(f).PruneCredentials(t.Context(), 200)
	if err != nil || n != 110 || len(f.pruneLimits) != 2 || f.pruneLimits[0] != 100 || f.pruneLimits[1] != 100 {
		t.Fatalf("batch: %d %v %v", n, f.pruneLimits, err)
	}
	f = newLifecycleFake()
	f.pruneCounts = make([]int, 20)
	for i := range f.pruneCounts {
		f.pruneCounts[i] = 100
	}
	n, err = NewGrantLifecycle(f).PruneCredentials(t.Context(), 5000)
	if err != nil || n != 2000 || len(f.pruneLimits) != 20 {
		t.Fatalf("bounded: %d calls=%d %v", n, len(f.pruneLimits), err)
	}
	if n, err = NewGrantLifecycle(newLifecycleFake()).PruneCredentials(t.Context(), 0); err != nil || n != 0 {
		t.Fatalf("zero budget: %d %v", n, err)
	}
}
