package service

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	usage "github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialusage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type appRotationDAO struct {
	store.GrantLifecycleDAO
	t     *testing.T
	grant store.OAuthGrant
	token string
	at    time.Time
	steps []string
}

func (d *appRotationDAO) step(name string) {
	d.t.Helper()
	if len(d.steps) == 0 || d.steps[0] != name {
		d.t.Fatalf("unexpected OAuth lifecycle operation %q, remaining %v", name, d.steps)
	}
	d.steps = d.steps[1:]
}

func (d *appRotationDAO) Refresh(_ context.Context, hash []byte, lock bool) (store.OAuthRefresh, error) {
	if lock {
		d.step("refresh locked")
	} else {
		d.step("refresh")
	}
	if !bytes.Equal(hash, secret.Hash(d.token)) {
		d.t.Fatal("unexpected refresh token hash")
	}
	return store.OAuthRefresh{GrantID: d.grant.ID, ClientID: d.grant.ClientID, ExpiresAt: d.grant.ExpiresAt}, nil
}

func (d *appRotationDAO) InspectGrant(_ context.Context, id string, lock bool) (store.OAuthGrant, error) {
	if lock {
		d.step("grant locked")
	} else {
		d.step("grant")
	}
	if id != d.grant.ID {
		d.t.Fatalf("grant ID %s, want %s", id, d.grant.ID)
	}
	return d.grant, nil
}

func (d *appRotationDAO) FreshTime(context.Context, time.Time) (time.Time, error) {
	d.step("time")
	return d.at, nil
}

func (d *appRotationDAO) RotateRefresh(_ context.Context, rotation store.OAuthRotation) error {
	d.step("rotate")
	if rotation.Grant.ID != d.grant.ID || !rotation.CreatedAt.Equal(d.at) || !bytes.Equal(rotation.OldHash, secret.Hash(d.token)) {
		d.t.Fatalf("unexpected rotation input %+v", rotation)
	}
	return nil
}

func TestAppRotationObserversShareProductionRecorder(t *testing.T) {
	written := make(chan model.CredentialUsageEvent, 4)
	app, backend := openUsageApp(t, func(_ context.Context, events []model.CredentialUsageEvent) (store.Completion, error) {
		for _, event := range events {
			written <- event
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	})
	if err := app.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if app.OAuthProfile == nil || app.OAuthGrants == app.OAuthProfile.Grants {
		t.Fatal("expected the two separately assembled lifecycle instances")
	}
	at := time.Now().UTC().Truncate(time.Microsecond)
	type request struct {
		dao       *appRotationDAO
		writes    int
		outcome   store.TransactionOutcome
		collector *usage.Collector
	}
	requests := make(map[string]*request)
	for _, name := range []string{"application", "public", "unknown"} {
		grant := store.OAuthGrant{ID: uuid.NewString(), UserID: uuid.NewString(), ClientID: "client", Resource: "https://daynight.example/mcp", Scope: oauth.Scope, ExpiresAt: at.Add(time.Hour)}
		requests[name] = &request{dao: &appRotationDAO{t: t, grant: grant, token: secret.Random(oauth.RefreshPrefix), at: at}, outcome: store.TransactionCommitted, collector: &usage.Collector{}}
	}
	requests["unknown"].outcome = store.TransactionUnknown
	commitLost := errors.New("commit response lost")
	backend.rotation = func(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
		r := requests[requestid.From(ctx)]
		if r == nil || r.writes >= 2 {
			t.Fatalf("unexpected lifecycle transaction for %q", requestid.From(ctx))
		}
		r.writes++
		if r.writes == 1 {
			r.dao.steps = []string{"refresh", "grant"}
		} else {
			r.dao.steps = []string{"refresh", "grant locked", "refresh locked", "time", "rotate"}
		}
		err := fn(r.dao)
		if err != nil || len(r.dao.steps) != 0 {
			t.Fatalf("lifecycle callback err=%v remaining=%v", err, r.dao.steps)
		}
		if r.writes == 2 && r.outcome == store.TransactionUnknown {
			return store.Completion{Outcome: r.outcome}, commitLost
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	for _, tc := range []struct {
		name      string
		lifecycle *oauth.GrantLifecycle
	}{
		{"application", app.OAuthGrants},
		{"public", app.OAuthProfile.Grants},
		{"unknown", app.OAuthProfile.Grants},
	} {
		r := requests[tc.name]
		ctx := usage.WithCollector(requestid.With(context.Background(), tc.name), r.collector)
		result, err := tc.lifecycle.Rotate(ctx, r.dao.token, r.dao.grant.ClientID, r.dao.grant.Resource, func(context.Context, string) error { return nil })
		if tc.name == "unknown" {
			if !errors.Is(err, oauth.ErrAuthorizationUnknown) || result != (oauth.RotatedTokens{}) {
				t.Fatalf("unknown rotation result=%+v err=%v", result, err)
			}
			fault, ok := r.collector.Snapshot()
			wantEvent := model.CredentialUsageEvent{Kind: model.UsageSubjectOAuthGrant, UserID: r.dao.grant.UserID, SubjectID: r.dao.grant.ID, At: at}
			if !ok || fault.Latest.Phase != usage.PhaseRotation || fault.Latest.Code != usage.CodeRotationOutcomeUnknown || fault.Latest.Cause != usage.CauseUnknown || fault.Latest.Observation.Source != usage.SourceOAuthRefresh || fault.Latest.Observation.RequestID != tc.name || fault.Latest.Observation.Event != wantEvent {
				t.Fatalf("unknown rotation fault=%+v present=%v", fault, ok)
			}
		} else if err != nil || result.AccessToken == "" {
			t.Fatalf("%s rotation result=%+v err=%v", tc.name, result, err)
		} else if fault, ok := r.collector.Snapshot(); ok {
			t.Fatalf("successful rotation fault=%+v", fault)
		}
		if r.writes != 2 {
			t.Fatalf("%s lifecycle transactions=%d", tc.name, r.writes)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := app.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	got := make(map[string]model.CredentialUsageEvent)
	for len(written) > 0 {
		event := <-written
		if _, duplicate := got[event.SubjectID]; duplicate {
			t.Fatalf("duplicate usage event for %s", event.SubjectID)
		}
		got[event.SubjectID] = event
	}
	if len(got) != 2 {
		t.Fatalf("recorded events=%+v, want the two confirmed rotations", got)
	}
	for _, name := range []string{"application", "public"} {
		r := requests[name]
		want := model.CredentialUsageEvent{Kind: model.UsageSubjectOAuthGrant, UserID: r.dao.grant.UserID, SubjectID: r.dao.grant.ID, At: at}
		if got[want.SubjectID] != want {
			t.Fatalf("%s event=%+v, want %+v", name, got[want.SubjectID], want)
		}
	}
}
