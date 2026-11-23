package github

import (
	"context"
	"errors"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type grantRecheckRead struct {
	store.GitHubGrantReadDAO
	location store.GitHubGrantLocation
}

func (r grantRecheckRead) Locate(context.Context, string, string, string) (store.GitHubGrantLocation, error) {
	return r.location, nil
}

type grantRecheckWrite struct {
	store.GitHubGrantWriteDAO
	facts             store.GitHubGrantWriteAdmission
	targetErr         error
	fullReads, writes int
}

func (w *grantRecheckWrite) GrantWriteAdmission(context.Context, string) (store.GitHubGrantWriteAdmission, error) {
	return w.facts, nil
}
func (w *grantRecheckWrite) RequireLiveGrant(context.Context, string) error { return w.targetErr }
func (w *grantRecheckWrite) Facts(context.Context, string) (store.GitHubGrantFacts, error) {
	w.fullReads++
	return store.GitHubGrantFacts{}, nil
}
func (w *grantRecheckWrite) Grant(context.Context, string) (store.GitHubTeamGrant, error) {
	w.fullReads++
	return store.GitHubTeamGrant{}, nil
}
func (w *grantRecheckWrite) StopGrantConnections(context.Context, string, store.GitHubStopDecision) error {
	w.writes++
	return nil
}
func (w *grantRecheckWrite) Revoke(context.Context, string) error { w.writes++; return nil }
func (w *grantRecheckWrite) AdvanceImpact(context.Context) error  { w.writes++; return nil }

type grantRecheckStore struct {
	located, release chan struct{}
	location         store.GitHubGrantLocation
	writer           *grantRecheckWrite
}

func (s *grantRecheckStore) ReadGitHubGrants(ctx context.Context, f func(store.GitHubGrantReadDAO) error) error {
	if err := f(grantRecheckRead{location: s.location}); err != nil {
		return err
	}
	close(s.located)
	select {
	case <-s.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (s *grantRecheckStore) WriteGitHubGrant(ctx context.Context, teamID, appID, actor string, f func(store.GitHubGrantWriteDAO) error) (store.Completion, error) {
	if teamID != s.location.TeamID {
		return store.Completion{}, errors.New("wrong Team")
	}
	err := f(s.writer)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func TestScopedRevokeGrantRechecksAfterLocation(t *testing.T) {
	original := scopeAppAuth(t, "github:manage")
	reduced := scopeAppAuth(t, "github:read")
	reduced.Principal = original.Principal
	app, teamID, grant := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, tc := range []struct {
		name      string
		targetErr error
		useReader bool
		want      string
	}{
		{"revoked scope", nil, true, "insufficient_scope"},
		{"missing reader", nil, false, "internal"},
		{"missing target", model.ErrNotFound, false, "github_grant_changed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			writer := &grantRecheckWrite{facts: store.GitHubGrantWriteAdmission{TeamID: teamID, TeamVersion: 1, AppVersion: 1, ImpactVersion: 1, IsAdmin: true}, targetErr: tc.targetErr}
			db := &grantRecheckStore{located: make(chan struct{}), release: make(chan struct{}), location: store.GitHubGrantLocation{TeamID: teamID, AppVersion: 1, ImpactVersion: 1}, writer: writer}
			current := original
			var reader AuthorizationReader
			if tc.useReader {
				reader = func(_ context.Context, got model.CredentialAuthorization) (model.CredentialAuthorization, error) {
					if got.Principal != original.Principal {
						t.Error("actor changed")
					}
					return current, nil
				}
			}
			manager := NewScopedGrantManager(db, nil, reader)
			done := make(chan error, 1)
			go func() {
				done <- manager.RevokeGrantAuthorized(t.Context(), original, app, grant, core.RevokeGrantInput{ExpectedUserID: original.Principal.UserID, Version: 1, ImpactVersion: 1})
			}()
			select {
			case <-db.located:
			case <-time.After(5 * time.Second):
				t.Fatal("location did not finish")
			}
			current = reduced
			close(db.release)
			err := <-done
			if tc.want == "internal" {
				if err == nil {
					t.Fatal("missing current credential accepted")
				}
			} else {
				scopeAppFault(t, err, tc.want)
			}
			if writer.fullReads != 0 || writer.writes != 0 {
				t.Fatalf("after denial: reads=%d writes=%d", writer.fullReads, writer.writes)
			}
		})
	}
}

func TestScopedRevokeCredentialRefusalPrecedesMissingScope(t *testing.T) {
	original := scopeAppAuth(t, "github:read")
	app, teamID, grant := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, reason := range []string{"revoked", "expired"} {
		t.Run(reason, func(t *testing.T) {
			writer := &grantRecheckWrite{facts: store.GitHubGrantWriteAdmission{TeamID: teamID, TeamVersion: 1, AppVersion: 1, ImpactVersion: 1, IsAdmin: true}}
			db := &grantRecheckStore{located: make(chan struct{}), release: make(chan struct{}), location: store.GitHubGrantLocation{TeamID: teamID, AppVersion: 1, ImpactVersion: 1}, writer: writer}
			currentErr := error(nil)
			manager := NewScopedGrantManager(db, nil, func(_ context.Context, got model.CredentialAuthorization) (model.CredentialAuthorization, error) {
				if got.Principal != original.Principal {
					t.Error("actor changed")
				}
				return original, currentErr
			})
			done := make(chan error, 1)
			go func() {
				done <- manager.RevokeGrantAuthorized(t.Context(), original, app, grant, core.RevokeGrantInput{ExpectedUserID: original.Principal.UserID, Version: 1, ImpactVersion: 1})
			}()
			select {
			case <-db.located:
			case <-time.After(5 * time.Second):
				t.Fatal("location did not finish")
			}
			currentErr = model.Unauthenticated(errors.New(reason))
			close(db.release)
			scopeAppFault(t, <-done, "unauthenticated")
			if writer.fullReads != 0 || writer.writes != 0 {
				t.Fatalf("after credential refusal: reads=%d writes=%d", writer.fullReads, writer.writes)
			}
		})
	}
}
