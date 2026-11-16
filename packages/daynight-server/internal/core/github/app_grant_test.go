package github

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type grantWriteStub struct {
	facts     store.GitHubGrantFacts
	current   *store.GitHubTeamGrant
	insertErr error
	steps     []string
}

func (s *grantWriteStub) Facts(context.Context, string) (store.GitHubGrantFacts, error) {
	s.steps = append(s.steps, "facts")
	return s.facts, nil
}
func (s *grantWriteStub) Grant(context.Context, string) (store.GitHubTeamGrant, error) {
	s.steps = append(s.steps, "grant")
	if s.current == nil {
		return store.GitHubTeamGrant{}, model.ErrNotFound
	}
	return *s.current, nil
}
func (s *grantWriteStub) LiveGrant(context.Context) (*store.GitHubTeamGrant, error) {
	s.steps = append(s.steps, "live")
	return s.current, nil
}
func (s *grantWriteStub) Insert(_ context.Context, id string) (store.GitHubTeamGrant, error) {
	s.steps = append(s.steps, "insert")
	return store.GitHubTeamGrant{ID: id}, s.insertErr
}
func (s *grantWriteStub) Revoke(context.Context, string) error {
	s.steps = append(s.steps, "revoke")
	return nil
}
func (s *grantWriteStub) StopGrantConnections(_ context.Context, _ string, d store.GitHubStopDecision) error {
	s.steps = append(s.steps, "stop")
	if d.Enabled || d.SyncEnabled || d.AccessState != "unknown" {
		return errors.New("bad stop decision")
	}
	return nil
}
func (s *grantWriteStub) AdvanceImpact(context.Context) error {
	s.steps = append(s.steps, "impact")
	return nil
}

func TestGrantDecisions(t *testing.T) {
	ctx := t.Context()
	actor, teamID, app, id := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	p := model.Principal{UserID: actor, CredentialID: uuid.NewString(), Kind: model.SessionCredential}
	in := CreateGrantInput{ID: id, TeamID: teamID, ExpectedUserID: actor, Version: 2, TeamVersion: 3}
	facts := store.GitHubGrantFacts{Team: store.GitHubGrantTeam{TeamRef: model.TeamRef{ID: teamID}, Version: 3}, AppVersion: 2, ImpactVersion: 4, IsAdmin: true}
	if err := ValidateCreateGrant(p, app, in); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name  string
		alter func(*grantWriteStub)
		code  string
		calls int
	}{
		{"unauthorized", func(s *grantWriteStub) { s.facts.IsAdmin = false }, "not_found", 1},
		{"app version", func(s *grantWriteStub) { s.facts.AppVersion = 1 }, "version_conflict", 1},
		{"team version", func(s *grantWriteStub) { s.facts.Team.Version = 1 }, "version_conflict", 1},
		{"impact exhausted", func(s *grantWriteStub) { s.facts.ImpactVersion = math.MaxInt64 }, "version_exhausted", 1},
		{"existing", func(s *grantWriteStub) { s.current = &store.GitHubTeamGrant{} }, "github_grant_changed", 2},
		{"identity reused", func(s *grantWriteStub) { s.insertErr = store.ErrGitHubGrantIDConflict }, "github_grant_changed", 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &grantWriteStub{facts: facts}
			tc.alter(s)
			_, err := CreateGrant(ctx, s, p, in)
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != tc.code || len(s.steps) != tc.calls {
				t.Fatalf("error=%v calls=%v", err, s.steps)
			}
		})
	}
	s := &grantWriteStub{facts: facts}
	g, err := CreateGrant(ctx, s, p, in)
	if err != nil || g.ID != id || len(s.steps) != 4 || s.steps[3] != "impact" {
		t.Fatalf("create=%+v %v %v", g, err, s.steps)
	}
	r := RevokeGrantInput{ExpectedUserID: actor, Version: 2, ImpactVersion: 4}
	s = &grantWriteStub{facts: facts, current: &store.GitHubTeamGrant{ID: id}}
	if err = ValidateRevokeGrant(p, app, id, r); err != nil {
		t.Fatal(err)
	}
	if err = RevokeGrant(ctx, s, p, id, r); err != nil || len(s.steps) != 5 || s.steps[2] != "stop" || s.steps[3] != "revoke" || s.steps[4] != "impact" {
		t.Fatalf("revoke: %v %v", err, s.steps)
	}
	s = &grantWriteStub{facts: facts}
	r.ImpactVersion = 3
	err = RevokeGrant(ctx, s, p, id, r)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "impact_changed" || len(s.steps) != 1 {
		t.Fatalf("stale impact: %v %v", err, s.steps)
	}
	r.ImpactVersion = 4
	err = RevokeGrant(ctx, s, p, id, r)
	if !errors.As(err, &fault) || fault.Code != "github_grant_changed" {
		t.Fatalf("stale grant: %v", err)
	}
}
