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
	"github.com/google/uuid"
)

type configServiceStub struct {
	facts                                                        store.GitHubAppConfigFacts
	writeFacts                                                   *store.GitHubAppConfigFacts
	reads, writes, updates, fences, stops, relations, tombstones int
	accessCalls, factsCalls                                      int
	outcome                                                      store.TransactionOutcome
	readErr, writeErr                                            error
	scopeErr                                                     error
}

func (s *configServiceStub) ReadGitHubAppConfig(ctx context.Context, id string, f func(store.GitHubAppConfigReader) error) error {
	s.reads++
	if id != s.facts.App.ID {
		panic("wrong ID")
	}
	if s.readErr != nil {
		return s.readErr
	}
	return f(s)
}
func (s *configServiceStub) WriteGitHubAppConfig(ctx context.Context, id string, f func(store.GitHubAppConfigWriter) error) (store.Completion, error) {
	s.writes++
	if id != s.facts.App.ID {
		panic("wrong ID")
	}
	if s.scopeErr != nil {
		return store.Completion{Outcome: s.outcome}, s.scopeErr
	}
	if s.writeFacts != nil {
		s.facts = *s.writeFacts
	}
	err := f(s)
	if s.writeErr != nil {
		err = s.writeErr
	}
	return store.Completion{Outcome: s.outcome}, err
}
func (s *configServiceStub) Facts(ctx context.Context, actor string) (store.GitHubAppConfigFacts, error) {
	s.factsCalls++
	if actor == "" {
		panic("missing actor")
	}
	if _, ok := ctx.Deadline(); !ok {
		panic("missing deadline")
	}
	return s.facts, nil
}
func (s *configServiceStub) Update(_ context.Context, in store.GitHubAppConfigUpdate) (githubpr.AppMetadata, error) {
	s.updates++
	return githubpr.AppMetadata{ID: s.facts.App.ID, Version: in.Version}, nil
}
func (s *configServiceStub) FenceConnections(context.Context, store.GitHubAppCredentialFence) error {
	s.fences++
	return nil
}
func (s *configServiceStub) StopAppConnections(context.Context, store.GitHubStopDecision) error {
	s.stops++
	return nil
}
func (s *configServiceStub) RemoveRelations(context.Context) error  { s.relations++; return nil }
func (s *configServiceStub) Tombstone(context.Context, int64) error { s.tombstones++; return nil }
func configPtr(s string) *string                                    { return &s }
func configServiceFixture(t *testing.T) (model.Principal, *configServiceStub, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	pemKey := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	s := &configServiceStub{outcome: store.TransactionCommitted, facts: store.GitHubAppConfigFacts{App: githubpr.AppMetadata{ID: uuid.NewString(), Name: "name", GitHubAppID: 9, Version: 3}, CredentialVersion: 4, ImpactVersion: 5, MembershipVersion: 6, Credentials: githubpr.AppCredentials{PrivateKeyPEM: []byte(pemKey), WebhookSecret: []byte("old")}}}
	return p, s, pemKey
}
func TestConfigManagerProofAndCommit(t *testing.T) {
	p, s, _ := configServiceFixture(t)
	id := s.facts.App.ID
	calls := 0
	m := &ConfigManager{db: s, verify: func(ctx context.Context, id int64, key *rsa.PrivateKey) (remote.AppIdentity, error) {
		calls++
		if id != 9 || key == nil {
			t.Fatal("wrong proof")
		}
		return remote.AppIdentity{ID: id, Name: "new", Slug: "new"}, nil
	}}
	in := core.UpdateAppInput{Version: 3, ExpectedUserID: p.UserID, WebhookSecret: configPtr("new")}
	out, err := m.UpdateApp(t.Context(), p, id, in)
	if err != nil || out.Version != 4 || calls != 1 || s.reads != 1 || s.writes != 1 || s.updates != 1 || s.fences != 1 {
		t.Fatalf("out=%+v err=%v calls=%d store=%+v", out, err, calls, s)
	}
	s.reads, s.writes, s.updates, s.fences, calls = 0, 0, 0, 0, 0
	in.WebhookSecret = configPtr("old")
	if _, err = m.UpdateApp(t.Context(), p, id, in); err != nil || calls != 0 || s.reads != 1 || s.writes != 1 || s.updates != 0 {
		t.Fatalf("same: %v %+v", err, s)
	}
	in.Version = 2
	s.writes = 0
	if _, err = m.UpdateApp(t.Context(), p, id, in); err == nil || s.writes != 0 || calls != 0 {
		t.Fatalf("stale: %v %+v", err, s)
	}
	in = core.UpdateAppInput{Version: 3, ExpectedUserID: p.UserID, Name: configPtr("renamed")}
	s.reads, s.writes = 0, 0
	if _, err = m.UpdateApp(t.Context(), p, id, in); err != nil || s.reads != 0 || s.writes != 1 || calls != 0 {
		t.Fatalf("name: %v %+v", err, s)
	}
}

func TestConfigManagerFailures(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		prepare               func(*configServiceStub, *core.UpdateAppInput)
		proofErr              error
		proofID               int64
		want                  string
		reads, writes, proofs int
	}{
		{"invalid actor", func(s *configServiceStub, in *core.UpdateAppInput) { in.ExpectedUserID = uuid.NewString() }, nil, 9, "fault", 0, 0, 0},
		{"read failure", func(s *configServiceStub, in *core.UpdateAppInput) { s.readErr = errors.New("read") }, nil, 9, "error", 1, 0, 0},
		{"stale", func(s *configServiceStub, in *core.UpdateAppInput) { in.Version = 2 }, nil, 9, "version_conflict", 1, 0, 0},
		{"bad key", func(s *configServiceStub, in *core.UpdateAppInput) { in.PrivateKeyPEM = configPtr("invalid") }, nil, 9, "github_app_credentials_invalid", 1, 0, 0},
		{"invalid remote", nil, remote.ErrAppCredentialsInvalid, 9, "github_app_credentials_invalid", 1, 0, 1},
		{"rate", nil, &remote.Error{Code: "rate_limited"}, 9, "github_rate_limited", 1, 0, 1},
		{"network", nil, errors.New("offline"), 9, "github_unavailable", 1, 0, 1},
		{"identity", nil, nil, 10, "github_app_credentials_invalid", 1, 0, 1},
		{"membership changed", func(s *configServiceStub, in *core.UpdateAppInput) {
			f := s.facts
			f.MembershipVersion++
			s.writeFacts = &f
		}, nil, 9, "github_admin_changed", 1, 1, 1},
		{"app deleted during proof", func(s *configServiceStub, in *core.UpdateAppInput) {
			s.outcome = store.TransactionNotCommitted
			s.scopeErr = &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}
		}, nil, 9, "github_admin_changed", 1, 1, 1},
		{"unknown", func(s *configServiceStub, in *core.UpdateAppInput) {
			s.outcome = store.TransactionUnknown
			s.writeErr = errors.New("lost")
		}, nil, 9, "github_write_outcome_unknown", 1, 1, 1},
		{"not committed", func(s *configServiceStub, in *core.UpdateAppInput) { s.outcome = store.TransactionNotCommitted }, nil, 9, "error", 1, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, s, _ := configServiceFixture(t)
			in := core.UpdateAppInput{Version: 3, ExpectedUserID: p.UserID, WebhookSecret: configPtr("new")}
			if tc.prepare != nil {
				tc.prepare(s, &in)
			}
			calls := 0
			m := &ConfigManager{db: s, verify: func(context.Context, int64, *rsa.PrivateKey) (remote.AppIdentity, error) {
				calls++
				return remote.AppIdentity{ID: tc.proofID}, tc.proofErr
			}}
			out, err := m.UpdateApp(t.Context(), p, s.facts.App.ID, in)
			if err == nil || out.ID != "" || s.reads != tc.reads || s.writes != tc.writes || calls != tc.proofs {
				t.Fatalf("out=%+v err=%v reads=%d writes=%d proofs=%d", out, err, s.reads, s.writes, calls)
			}
			var me *ManagementError
			var f *model.Fault
			if tc.want != "error" && tc.want != "fault" && !(errors.As(err, &me) && me.Code == tc.want) && !(errors.As(err, &f) && f.Code == tc.want) {
				t.Fatalf("unexpected %v", err)
			}
		})
	}
}
func TestConfigManagerRemove(t *testing.T) {
	p, s, _ := configServiceFixture(t)
	m := NewConfigManager(s)
	in := core.RemoveAppInput{ExpectedUserID: p.UserID, Version: 3, ImpactVersion: 5}
	if err := m.RemoveApp(t.Context(), p, s.facts.App.ID, in); err != nil || s.writes != 1 || s.stops != 1 || s.relations != 1 || s.tombstones != 1 {
		t.Fatalf("remove: %v %+v", err, s)
	}
	in.ImpactVersion = 4
	s.stops = 0
	if err := m.RemoveApp(t.Context(), p, s.facts.App.ID, in); err == nil || s.stops != 0 {
		t.Fatalf("stale: %v %+v", err, s)
	}
	in.ImpactVersion = 5
	s.outcome = store.TransactionUnknown
	s.writeErr = errors.New("lost")
	var me *ManagementError
	if err := m.RemoveApp(t.Context(), p, s.facts.App.ID, in); !errors.As(err, &me) || me.Code != "github_write_outcome_unknown" {
		t.Fatalf("unknown: %v", err)
	}
	in.Version = 0
	s.writes = 0
	if err := m.RemoveApp(t.Context(), p, s.facts.App.ID, in); err == nil || s.writes != 0 {
		t.Fatalf("invalid: %v", err)
	}
}

func TestConfigCompletionAndProofCancellation(t *testing.T) {
	missing := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}
	err := appConfigCompletion(store.Completion{Outcome: store.TransactionNotCommitted}, missing, false)
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != "not_found" || !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	err = appConfigCompletion(store.Completion{Outcome: store.TransactionNotCommitted}, missing, true)
	if !errors.As(err, &f) || f.Code != "github_admin_changed" || !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("proven missing: %v", err)
	}
	for _, e := range []error{
		&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound, CleanupFailed: true},
		&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &store.Error{DatabaseFailure: true, Cause: model.ErrNotFound}},
	} {
		if got := appConfigCompletion(store.Completion{Outcome: store.TransactionNotCommitted}, e, true); got != e {
			t.Fatalf("must preserve error: %v", got)
		}
	}
	var me *ManagementError
	if got := appConfigCompletion(store.Completion{Outcome: store.TransactionUnknown}, missing, true); !errors.As(got, &me) || me.Code != "github_write_outcome_unknown" {
		t.Fatalf("unknown: %v", got)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err = appProofError(ctx, errors.New("offline")); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
}
