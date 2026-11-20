package github

import (
	"context"
	"crypto/rsa"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

func (s *configServiceStub) ConfigAccess(_ context.Context, _ string) (store.GitHubAppConfigAccess, error) {
	s.accessCalls++
	return store.GitHubAppConfigAccess{AppVersion: s.facts.App.Version, ImpactVersion: s.facts.ImpactVersion, MembershipVersion: s.facts.MembershipVersion}, nil
}

func TestScopedConfigRetainsVisibilityAndPreventsProofAndMutation(t *testing.T) {
	_, db, _ := configServiceFixture(t)
	auth := scopeAppAuth(t, "github:manage")
	proofCalls := 0
	m := &ConfigManager{db: db, verify: func(context.Context, int64, *rsa.PrivateKey) (remote.AppIdentity, error) {
		proofCalls++
		return remote.AppIdentity{}, nil
	}}
	input := core.UpdateAppInput{Version: 3, ExpectedUserID: auth.Principal.UserID, WebhookSecret: configPtr("new")}
	db.facts.App.Version = 4
	_, err := m.UpdateAppAuthorized(t.Context(), auth, db.facts.App.ID, input)
	scopeAppFault(t, err, "version_conflict")
	db.facts.App.Version = 3
	_, err = m.UpdateAppAuthorized(t.Context(), auth, db.facts.App.ID, input)
	scopeAppFault(t, err, "insufficient_scope")
	if proofCalls != 0 || db.writes != 0 || db.updates != 0 || db.factsCalls != 0 {
		t.Fatal("refused secret update performed proof or write")
	}
	input.WebhookSecret = nil
	input.Name = configPtr("new")
	_, err = m.UpdateAppAuthorized(t.Context(), auth, db.facts.App.ID, input)
	scopeAppFault(t, err, "insufficient_scope")
	if db.updates != 0 || db.fences != 0 {
		t.Fatal("refused update mutated app")
	}
	read := scopeAppAuth(t, "github:read")
	read.Principal = auth.Principal
	err = m.RemoveAppAuthorized(t.Context(), read, db.facts.App.ID, core.RemoveAppInput{Version: 3, ImpactVersion: 5, ExpectedUserID: auth.Principal.UserID})
	scopeAppFault(t, err, "insufficient_scope")
	if db.relations != 0 || db.stops != 0 || db.tombstones != 0 {
		t.Fatal("refused deletion mutated app")
	}
	both := scopeAppAuth(t, "github:manage", "github:read")
	both.Principal = auth.Principal
	if _, err = m.UpdateAppAuthorized(t.Context(), both, db.facts.App.ID, input); err != nil || db.updates != 1 {
		t.Fatalf("authorized update: %v", err)
	}
}

func TestScopedConfigRechecksAuthorityAfterRemoteProof(t *testing.T) {
	_, db, _ := configServiceFixture(t)
	original := scopeAppAuth(t, "github:manage", "github:read")
	reduced := scopeAppAuth(t, "github:read")
	reduced.Principal = original.Principal
	started, release := make(chan struct{}), make(chan struct{})
	m := &ConfigManager{db: db, verify: func(_ context.Context, id int64, _ *rsa.PrivateKey) (remote.AppIdentity, error) {
		close(started)
		<-release
		return remote.AppIdentity{ID: id, Name: "verified", Slug: "verified"}, nil
	}, current: func(_ context.Context, got model.CredentialAuthorization) (model.CredentialAuthorization, error) {
		if got.Principal != original.Principal || got.Profile != original.Profile {
			t.Error("credential identity changed")
		}
		return reduced, nil
	}}
	input := core.UpdateAppInput{Version: 3, ExpectedUserID: original.Principal.UserID, WebhookSecret: configPtr("new")}
	done := make(chan error, 1)
	go func() { _, err := m.UpdateAppAuthorized(t.Context(), original, db.facts.App.ID, input); done <- err }()
	<-started
	close(release)
	err := <-done
	scopeAppFault(t, err, "insufficient_scope")
	if db.updates != 0 || db.fences != 0 {
		t.Fatal("scope revoked during proof mutated App")
	}
}

type configPreReadBarrier struct {
	*configServiceStub
	started, release chan struct{}
}

func (s configPreReadBarrier) ReadGitHubAppConfig(ctx context.Context, id string, work func(store.GitHubAppConfigReader) error) error {
	err := s.configServiceStub.ReadGitHubAppConfig(ctx, id, work)
	close(s.started)
	select {
	case <-s.release:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}
func TestScopedConfigRechecksAuthorityAfterUnchangedSecretPreRead(t *testing.T) {
	_, db, _ := configServiceFixture(t)
	original := scopeAppAuth(t, "github:manage", "github:read")
	reduced := scopeAppAuth(t, "github:read")
	reduced.Principal = original.Principal
	started, release := make(chan struct{}), make(chan struct{})
	m := &ConfigManager{db: configPreReadBarrier{db, started, release}, current: func(context.Context, model.CredentialAuthorization) (model.CredentialAuthorization, error) {
		return reduced, nil
	}}
	input := core.UpdateAppInput{Version: 3, ExpectedUserID: original.Principal.UserID, Name: configPtr("renamed"), WebhookSecret: configPtr("old")}
	done := make(chan error, 1)
	go func() { _, err := m.UpdateAppAuthorized(t.Context(), original, db.facts.App.ID, input); done <- err }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("pre-read did not start")
	}
	close(release)
	select {
	case err := <-done:
		scopeAppFault(t, err, "insufficient_scope")
	case <-time.After(5 * time.Second):
		t.Fatal("update did not return")
	}
	if db.updates != 0 || db.fences != 0 {
		t.Fatal("scope revoked after pre-read mutated App")
	}
}
