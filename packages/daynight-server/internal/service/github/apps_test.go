package github

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

type appTestStore struct {
	outcome    store.TransactionOutcome
	writeErr   error
	writeCalls int
	input      store.GitHubAppCreate
	readErr    error
	readCalls  int
	missing    bool
	finishErr  error
}

func (s *appTestStore) WriteGitHubApp(ctx context.Context, f func(store.GitHubAppWriteDAO) error) (store.Completion, error) {
	s.writeCalls++
	err := f(s)
	if s.writeErr != nil {
		err = s.writeErr
	}
	return store.Completion{Outcome: s.outcome}, err
}
func (s *appTestStore) ReadGitHubApps(ctx context.Context, f func(store.GitHubAppReadDAO) error) error {
	s.readCalls++
	if s.readErr != nil {
		return s.readErr
	}
	err := f(s)
	if s.finishErr != nil {
		return s.finishErr
	}
	return err
}
func (s *appTestStore) Create(_ context.Context, in store.GitHubAppCreate) (githubpr.AppMetadata, error) {
	s.input = in
	return githubpr.AppMetadata{ID: in.ID}, nil
}
func (s *appTestStore) Get(_ context.Context, id, actor string) (githubpr.AppMetadata, error) {
	if actor == "" {
		panic("missing actor")
	}
	if s.missing {
		return githubpr.AppMetadata{}, model.ErrNotFound
	}
	return githubpr.AppMetadata{ID: id}, nil
}
func (s *appTestStore) List(_ context.Context, q store.GitHubAppQuery) (store.GitHubAppPage, error) {
	if q.ActorID == "" {
		panic("missing actor")
	}
	return store.GitHubAppPage{Items: []githubpr.AppMetadata{{ID: "listed"}}}, nil
}
func TestAppManagerCreate(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	pemKey := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	p := model.Principal{Kind: model.SessionCredential, CredentialID: "33333333-3333-4333-8333-333333333333", UserID: "a29f02b3-8966-412e-a789-847503bb40de"}
	in := core.CreateAppInput{ID: "7cb65a54-6173-42fa-b789-df86414a19c1", Name: "App", GitHubAppID: 9, PrivateKeyPEM: pemKey, WebhookSecret: " secret ", ExpectedUserID: p.UserID}
	for _, tc := range []struct {
		name               string
		proofErr, writeErr error
		outcome            store.TransactionOutcome
		code               string
		writes             int
	}{
		{name: "committed", outcome: store.TransactionCommitted, writes: 1},
		{name: "invalid credentials", proofErr: remote.ErrAppCredentialsInvalid, code: "github_app_credentials_invalid"},
		{name: "network", proofErr: errors.New("offline"), code: "github_unavailable"},
		{name: "forbidden", proofErr: &remote.Error{Code: "permission_denied", Status: 403}, code: "github_unavailable"},
		{name: "not found", proofErr: &remote.Error{Code: "not_found", Status: 404}, code: "github_unavailable"},
		{name: "rate limited", proofErr: &remote.Error{Code: "rate_limited", Status: 429}, code: "github_rate_limited"},
		{name: "external conflict", writeErr: store.ErrGitHubAppIDConflict, outcome: store.TransactionNotCommitted, code: "github_app_already_registered", writes: 1},
		{name: "resource conflict", writeErr: store.ErrGitHubAppResourceIDConflict, outcome: store.TransactionNotCommitted, code: "github_app_id_conflict", writes: 1},
		{name: "unknown", writeErr: store.ErrGitHubAppIDConflict, outcome: store.TransactionUnknown, code: "github_write_outcome_unknown", writes: 1},
		{name: "not committed", outcome: store.TransactionNotCommitted, writes: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := &appTestStore{outcome: tc.outcome, writeErr: tc.writeErr}
			calls := 0
			m := &AppManager{db: db, verify: func(ctx context.Context, id int64, k *rsa.PrivateKey) (remote.AppIdentity, error) {
				calls++
				if id != 9 || k.N.Cmp(key.N) != 0 {
					t.Fatal("incorrect proof")
				}
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("no budget")
				}
				return remote.AppIdentity{ID: id, Name: "Remote", Slug: "remote"}, tc.proofErr
			}}
			got, err := m.CreateApp(context.Background(), p, in)
			if calls != 1 || db.writeCalls != tc.writes {
				t.Fatalf("calls proof=%d write=%d", calls, db.writeCalls)
			}
			if tc.code != "" {
				var e *ManagementError
				if !errors.As(err, &e) || e.Code != tc.code {
					t.Fatalf("error %v", err)
				}
				return
			}
			if tc.name == "not committed" {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			if err != nil || got.ID != in.ID || db.input.CreatorUserID != p.UserID || db.input.GitHubName != "Remote" || string(db.input.Credentials.WebhookSecret) != in.WebhookSecret {
				t.Fatalf("result %#v error %v", got, err)
			}
		})
	}
	db := &appTestStore{}
	m := &AppManager{db: db, verify: func(context.Context, int64, *rsa.PrivateKey) (remote.AppIdentity, error) {
		t.Fatal("unexpected proof")
		return remote.AppIdentity{}, nil
	}}
	invalid := in
	invalid.PrivateKeyPEM = "bad"
	_, err = m.CreateApp(context.Background(), p, invalid)
	var failure *ManagementError
	if !errors.As(err, &failure) || failure.Code != "github_app_credentials_invalid" || db.writeCalls != 0 {
		t.Fatalf("invalid key: %v", err)
	}
	invalid = in
	invalid.ExpectedUserID = "bad"
	if _, err = m.CreateApp(context.Background(), p, invalid); err == nil || db.writeCalls != 0 {
		t.Fatal("invalid actor accepted")
	}
}
func TestAppManagerRead(t *testing.T) {
	p := model.Principal{Kind: model.SessionCredential, CredentialID: "33333333-3333-4333-8333-333333333333", UserID: "a29f02b3-8966-412e-a789-847503bb40de"}
	id := "7cb65a54-6173-42fa-b789-df86414a19c1"
	db := &appTestStore{}
	m := NewAppManager(db)
	got, err := m.GetApp(context.Background(), p, id)
	if err != nil || got.ID != id {
		t.Fatalf("get %#v %v", got, err)
	}
	page, err := m.ListApps(context.Background(), p, core.ListAppsInput{})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("list %#v %v", page, err)
	}
	if _, err = m.GetApp(context.Background(), p, "bad"); err == nil || db.readCalls != 2 {
		t.Fatal("invalid ID read")
	}
	db.missing = true
	_, err = m.GetApp(context.Background(), p, id)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "not_found" {
		t.Fatalf("missing: %v", err)
	}
	db.finishErr = errors.New("snapshot completion failed")
	if _, err = m.GetApp(context.Background(), p, id); !errors.Is(err, db.finishErr) {
		t.Fatalf("completion: %v", err)
	}
	db.finishErr = nil
	db.readErr = errors.New("read failed")
	if _, err = m.GetApp(context.Background(), p, id); !errors.Is(err, db.readErr) {
		t.Fatalf("read error %v", err)
	}
}
