package identity

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type deviceScopeFixture struct {
	store.IdentityDAO
	device   model.DeviceAuthorization
	fresh    time.Time
	writes   int
	selected []scopepolicy.ScopeID
}

func (d *deviceScopeFixture) LockSession(context.Context, model.Principal, time.Time) error {
	return nil
}
func (d *deviceScopeFixture) DeviceByUserCode(context.Context, string, string, bool) (model.DeviceAuthorization, error) {
	return d.device, nil
}
func (d *deviceScopeFixture) LockDeviceByHash(context.Context, []byte) (model.DeviceAuthorization, error) {
	return d.device, nil
}
func (d *deviceScopeFixture) FreshPATTime(context.Context, time.Time) (time.Time, error) {
	return d.fresh, nil
}
func (d *deviceScopeFixture) SetScopedDeviceDecision(_ context.Context, _, _, _ string, scopes []scopepolicy.ScopeID) error {
	d.writes++
	d.selected = scopes
	return nil
}
func (d *deviceScopeFixture) InsertPAT(context.Context, model.PersonalAccessToken) error {
	d.writes++
	return nil
}
func (d *deviceScopeFixture) ConsumeDevice(context.Context, string) error { d.writes++; return nil }

type deviceScopeWriter struct {
	dao       *deviceScopeFixture
	result    store.Completion
	callbacks int
}
type deviceScopeHolder struct {
	store.IdentityScope
	dao store.IdentityDAO
}

func (s deviceScopeHolder) IdentityDAO() store.IdentityDAO { return s.dao }
func (w *deviceScopeWriter) WriteIdentity(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
	w.callbacks++
	if err := fn(deviceScopeHolder{dao: w.dao}); err != nil {
		return store.Completion{}, err
	}
	return w.result, nil
}

func TestScopedDeviceServiceCatalogAndUnknownCompletion(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	user := "123e4567-e89b-12d3-a456-426614174000"
	p := model.Principal{Kind: model.SessionCredential, UserID: user}
	dao := &deviceScopeFixture{fresh: now, device: model.DeviceAuthorization{ID: "device", UserCode: "BCDFGHJKLM", Status: "pending", ExpiresAt: now.Add(time.Hour), NextPollAt: now}}
	writer := &deviceScopeWriter{dao: dao, result: store.Completion{Outcome: store.TransactionCommitted}}
	catalog, err := scopepolicy.NewCatalogSnapshot(scopepolicy.PAT, []scopepolicy.ScopeID{"project:read", "task:read"})
	if err != nil {
		t.Fatal(err)
	}
	s := NewWithDeviceScopes(writer, nil, "", catalog)
	s.now = func() time.Time { return now }
	s.ops.deviceRate = func(context.Context, store.IdentityDAO, string, string, int, int, time.Time) error { return nil }
	if _, enabled := New(nil, nil, "").DeviceScopeCatalog(); enabled {
		t.Fatal("legacy service exposes scoped catalog")
	}
	copy, enabled := s.DeviceScopeCatalog()
	if !enabled || copy.CatalogRevision != catalog.CatalogRevision {
		t.Fatal("scoped catalog unavailable")
	}
	copy.Groups[0].ScopeIDs[0] = "mutated"
	copyAgain, _ := s.DeviceScopeCatalog()
	if copyAgain.Groups[0].ScopeIDs[0] == "mutated" {
		t.Fatal("catalog shares caller storage")
	}
	inspect, err := s.InspectDeviceV2(t.Context(), p, dao.device.UserCode)
	if err != nil || inspect.CatalogRevision == nil || *inspect.CatalogRevision != catalog.CatalogRevision {
		t.Fatalf("inspect=%+v %v", inspect, err)
	}
	for _, tc := range []struct {
		revision string
		scopes   []scopepolicy.ScopeID
		fault    string
	}{{"stale", []scopepolicy.ScopeID{"task:read"}, "version_conflict"}, {catalog.CatalogRevision, nil, "invalid_input"}, {catalog.CatalogRevision, []scopepolicy.ScopeID{"team:read"}, "invalid_input"}} {
		before := dao.writes
		err = s.DecideDeviceV2(t.Context(), p, dao.device.UserCode, "approve", user, tc.revision, tc.scopes)
		requireFault(t, err, tc.fault)
		if dao.writes != before {
			t.Fatal("invalid decision wrote")
		}
	}
	err = s.DecideDeviceV2(t.Context(), p, dao.device.UserCode, "approve", user, catalog.CatalogRevision, []scopepolicy.ScopeID{"task:read", "project:read"})
	if err != nil || !reflect.DeepEqual(dao.selected, []scopepolicy.ScopeID{"project:read", "task:read"}) {
		t.Fatalf("decision %v %v", dao.selected, err)
	}
	if err = s.DecideDevice(t.Context(), p, dao.device.UserCode, "approve", user); err == nil {
		t.Fatal("legacy approval without scopes accepted")
	}
	dao.device.Status = "approved"
	dao.device.UserID = &user
	dao.device.ApprovedScopes = dao.selected
	writer.result = store.Completion{Outcome: store.TransactionUnknown}
	before := writer.callbacks
	got, err := s.RedeemDevice(t.Context(), core.DeviceClientID, core.DeviceGrantType, secret.Random(""), "machine")
	var unknown *store.TransactionError
	if !errors.As(err, &unknown) || unknown.Outcome != store.TransactionUnknown || got.Secret != "" || writer.callbacks != before+1 {
		t.Fatalf("unknown completion exposed token or replayed: %q %v", got.Secret, err)
	}
}
