package github

import (
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func grantTestPrincipal() model.Principal {
	return model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
}

func requireGrantFault(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("error=%v, want %s", err, code)
	}
}

func TestGrantInputValidation(t *testing.T) {
	p := grantTestPrincipal()
	app, teamID, id := uuid.NewString(), uuid.NewString(), "abcdefab-cdef-4abc-8abc-abcdefabcdef"
	create := CreateGrantInput{ID: id, TeamID: teamID, ExpectedUserID: p.UserID, Version: 1, TeamVersion: 1}
	revoke := RevokeGrantInput{ExpectedUserID: p.UserID, Version: 1, ImpactVersion: 1}
	cases := []struct {
		name    string
		app, id string
		create  CreateGrantInput
		revoke  RevokeGrantInput
		code    string
	}{
		{"account changed", app, id, func() CreateGrantInput { v := create; v.ExpectedUserID = uuid.NewString(); return v }(), func() RevokeGrantInput { v := revoke; v.ExpectedUserID = uuid.NewString(); return v }(), "identity_mismatch"},
		{"bad app", "not-uuid", id, create, revoke, "invalid_input"},
		{"bad grant", app, "not-uuid", func() CreateGrantInput { v := create; v.ID = "not-uuid"; return v }(), revoke, "invalid_input"},
		{"noncanonical grant", app, strings.ToUpper(id), func() CreateGrantInput { v := create; v.ID = strings.ToUpper(id); return v }(), revoke, "invalid_input"},
		{"zero app version", app, id, func() CreateGrantInput { v := create; v.Version = 0; return v }(), func() RevokeGrantInput { v := revoke; v.Version = 0; return v }(), "invalid_input"},
		{"zero other version", app, id, func() CreateGrantInput { v := create; v.TeamVersion = 0; return v }(), func() RevokeGrantInput { v := revoke; v.ImpactVersion = 0; return v }(), "invalid_input"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			requireGrantFault(t, ValidateCreateGrant(p, tc.app, tc.create), tc.code)
			requireGrantFault(t, ValidateRevokeGrant(p, tc.app, tc.id, tc.revoke), tc.code)
		})
	}
	badTeam := create
	badTeam.TeamID = "bad"
	requireGrantFault(t, ValidateCreateGrant(p, app, badTeam), "invalid_input")
	requireGrantFault(t, ValidateCreateGrant(model.Principal{}, app, create), "unauthenticated")
	requireGrantFault(t, ValidateRevokeGrant(model.Principal{}, app, id, revoke), "unauthenticated")
}

type grantReadFixture struct {
	t                       *testing.T
	app, actor, team, grant string
	calls                   int
	after                   *string
	limit                   int
	failure                 error
	grantPage               store.GitHubGrantPage
	teamPage                store.GitHubTeamAppPage
}

func (s *grantReadFixture) Locate(context.Context, string, string, string) (store.GitHubGrantLocation, error) {
	s.t.Fatal("unexpected Locate")
	return store.GitHubGrantLocation{}, nil
}
func (s *grantReadFixture) Preview(_ context.Context, app, actor, team string) (store.GitHubGrantPreview, error) {
	s.calls++
	if app != s.app || actor != s.actor || team != s.team {
		s.t.Fatalf("preview arguments: %q %q %q", app, actor, team)
	}
	return store.GitHubGrantPreview{AppID: app}, s.failure
}
func (s *grantReadFixture) Grant(_ context.Context, app, actor, id string) (store.GitHubTeamGrant, error) {
	s.calls++
	if app != s.app || actor != s.actor || id != s.grant {
		s.t.Fatalf("grant arguments: %q %q %q", app, actor, id)
	}
	return store.GitHubTeamGrant{ID: id}, s.failure
}
func (s *grantReadFixture) Grants(_ context.Context, app, actor string, after *string, limit int) (store.GitHubGrantPage, error) {
	s.calls++
	if app != s.app || actor != s.actor || limit != s.limit || !reflect.DeepEqual(after, s.after) {
		s.t.Fatalf("grants arguments: %q %q %v %d", app, actor, after, limit)
	}
	return s.grantPage, s.failure
}
func (s *grantReadFixture) TeamApps(_ context.Context, team, actor string, after *string, limit int) (store.GitHubTeamAppPage, error) {
	s.calls++
	if team != s.team || actor != s.actor || limit != s.limit || !reflect.DeepEqual(after, s.after) {
		s.t.Fatalf("team apps arguments: %q %q %v %d", team, actor, after, limit)
	}
	return s.teamPage, s.failure
}

func TestGrantReadsValidateAndPreserveFailures(t *testing.T) {
	p := grantTestPrincipal()
	app, teamID, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
	s := &grantReadFixture{t: t, app: app, actor: p.UserID, team: teamID, grant: id}
	if got, err := PreviewGrant(t.Context(), s, p, app, teamID); err != nil || got.AppID != app {
		t.Fatalf("preview=%+v %v", got, err)
	}
	if got, err := GetGrant(t.Context(), s, p, app, id); err != nil || got.ID != id {
		t.Fatalf("grant=%+v %v", got, err)
	}
	for _, call := range []func() error{
		func() error { _, e := PreviewGrant(t.Context(), s, model.Principal{}, app, teamID); return e },
		func() error { _, e := GetGrant(t.Context(), s, model.Principal{}, app, id); return e },
		func() error { _, e := PreviewGrant(t.Context(), s, p, app, "bad"); return e },
		func() error { _, e := GetGrant(t.Context(), s, p, app, "bad"); return e },
	} {
		if call() == nil {
			t.Fatal("invalid read was accepted")
		}
	}
	if s.calls != 2 {
		t.Fatalf("refusal queried DAO: %d", s.calls)
	}
	s.failure = model.ErrNotFound
	_, err := PreviewGrant(t.Context(), s, p, app, teamID)
	requireGrantFault(t, err, "not_found")
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("lost cause: %v", err)
	}
	_, err = GetGrant(t.Context(), s, p, app, id)
	requireGrantFault(t, err, "not_found")
	sentinel := errors.New("read failed")
	s.failure = sentinel
	_, err = PreviewGrant(t.Context(), s, p, app, teamID)
	if !errors.Is(err, sentinel) {
		t.Fatalf("lost error: %v", err)
	}
}

func TestGrantListPaginationAndScope(t *testing.T) {
	p := grantTestPrincipal()
	app, teamID, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
	stamp := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s := &grantReadFixture{t: t, app: app, actor: p.UserID, team: teamID, limit: 25,
		grantPage: store.GitHubGrantPage{Items: []store.GitHubTeamGrant{{ID: id, CreatedAt: stamp}}, HasMore: true},
		teamPage:  store.GitHubTeamAppPage{Items: []store.GitHubTeamApp{{GrantID: id, CreatedAt: stamp}}, HasMore: true}}
	page, err := ListGrants(t.Context(), s, p, app, model.PageRequest{})
	if err != nil || page.NextCursor == nil || len(page.Items) != 1 {
		t.Fatalf("grant page: %+v %v", page, err)
	}
	grantCursor := page.NextCursor
	s.after = &id
	s.grantPage = store.GitHubGrantPage{}
	page, err = ListGrants(t.Context(), s, p, app, model.PageRequest{Cursor: page.NextCursor})
	if err != nil || page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil {
		t.Fatalf("last page: %+v %v", page, err)
	}
	s.after = nil
	teamPage, err := ListTeamApps(t.Context(), s, p, teamID, model.PageRequest{})
	if err != nil || teamPage.NextCursor == nil || len(teamPage.Items) != 1 {
		t.Fatalf("team page: %+v %v", teamPage, err)
	}
	teamCursor := teamPage.NextCursor
	s.after = &id
	s.teamPage = store.GitHubTeamAppPage{}
	teamPage, err = ListTeamApps(t.Context(), s, p, teamID, model.PageRequest{Cursor: teamPage.NextCursor})
	if err != nil || teamPage.Items == nil || len(teamPage.Items) != 0 || teamPage.NextCursor != nil {
		t.Fatalf("last team page: %+v %v", teamPage, err)
	}
	before := s.calls
	badCursor := "invalid"
	_, err = ListGrants(t.Context(), s, p, app, model.PageRequest{Limit: 1, Cursor: &badCursor})
	if err == nil {
		t.Fatal("invalid grant cursor")
	}
	_, err = ListTeamApps(t.Context(), s, p, teamID, model.PageRequest{Limit: 101})
	if err == nil {
		t.Fatal("invalid team limit")
	}
	_, err = ListGrants(t.Context(), s, model.Principal{}, app, model.PageRequest{})
	if err == nil {
		t.Fatal("unauthenticated grant list")
	}
	_, err = ListTeamApps(t.Context(), s, p, "bad", model.PageRequest{})
	if err == nil {
		t.Fatal("invalid team ID")
	}
	_, err = ListTeamApps(t.Context(), s, model.Principal{}, teamID, model.PageRequest{})
	if err == nil {
		t.Fatal("unauthenticated team list")
	}
	other := p
	other.UserID = uuid.NewString()
	_, err = ListGrants(t.Context(), s, other, app, model.PageRequest{Limit: 25, Cursor: grantCursor})
	if err == nil {
		t.Fatal("grant cursor accepted another actor")
	}
	_, err = ListTeamApps(t.Context(), s, p, uuid.NewString(), model.PageRequest{Limit: 25, Cursor: teamCursor})
	if err == nil {
		t.Fatal("Team cursor accepted another Team")
	}
	if s.calls != before {
		t.Fatalf("invalid list queried DAO: %d => %d", before, s.calls)
	}
	s.after = nil
	s.failure = model.ErrNotFound
	_, err = ListGrants(t.Context(), s, p, app, model.PageRequest{})
	requireGrantFault(t, err, "not_found")
	_, err = ListTeamApps(t.Context(), s, p, teamID, model.PageRequest{})
	requireGrantFault(t, err, "not_found")
}

type revokeFailureDAO struct {
	t     *testing.T
	facts store.GitHubGrantFacts
	fail  string
	cause error
	calls []string
}

func (s *revokeFailureDAO) check(name string) error {
	s.calls = append(s.calls, name)
	if s.fail == name {
		return s.cause
	}
	return nil
}
func (s *revokeFailureDAO) Facts(_ context.Context, _ string) (store.GitHubGrantFacts, error) {
	return s.facts, s.check("facts")
}
func (s *revokeFailureDAO) Grant(_ context.Context, id string) (store.GitHubTeamGrant, error) {
	return store.GitHubTeamGrant{ID: id}, s.check("grant")
}
func (s *revokeFailureDAO) LiveGrant(context.Context) (*store.GitHubTeamGrant, error) {
	s.t.Fatal("unexpected LiveGrant")
	return nil, nil
}
func (s *revokeFailureDAO) Insert(context.Context, string) (store.GitHubTeamGrant, error) {
	s.t.Fatal("unexpected Insert")
	return store.GitHubTeamGrant{}, nil
}
func (s *revokeFailureDAO) StopGrantConnections(_ context.Context, _ string, d store.GitHubStopDecision) error {
	if d.Enabled || d.SyncEnabled || d.AccessState != "unknown" {
		s.t.Fatalf("stop decision=%+v", d)
	}
	return s.check("stop")
}
func (s *revokeFailureDAO) Revoke(context.Context, string) error { return s.check("revoke") }
func (s *revokeFailureDAO) AdvanceImpact(context.Context) error  { return s.check("impact") }

func TestRevokeGrantFailureOrdering(t *testing.T) {
	p := grantTestPrincipal()
	id := uuid.NewString()
	in := RevokeGrantInput{ExpectedUserID: p.UserID, Version: 2, ImpactVersion: 3}
	facts := store.GitHubGrantFacts{IsAdmin: true, AppVersion: 2, ImpactVersion: 3}
	for _, tc := range []struct {
		name     string
		expected []string
	}{
		{"facts", []string{"facts"}}, {"grant", []string{"facts", "grant"}}, {"stop", []string{"facts", "grant", "stop"}}, {"revoke", []string{"facts", "grant", "stop", "revoke"}}, {"impact", []string{"facts", "grant", "stop", "revoke", "impact"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cause := errors.New(tc.name + " failed")
			s := &revokeFailureDAO{t: t, facts: facts, fail: tc.name, cause: cause}
			err := RevokeGrant(t.Context(), s, p, id, in)
			if !errors.Is(err, cause) || !reflect.DeepEqual(s.calls, tc.expected) {
				t.Fatalf("error=%v calls=%v", err, s.calls)
			}
		})
	}
	s := &revokeFailureDAO{t: t, facts: facts}
	bad := in
	bad.ExpectedUserID = uuid.NewString()
	requireGrantFault(t, RevokeGrant(t.Context(), s, p, id, bad), "identity_mismatch")
	if len(s.calls) != 0 {
		t.Fatalf("identity refusal called DAO: %v", s.calls)
	}
	s.facts.ImpactVersion = math.MaxInt64
	in.ImpactVersion = math.MaxInt64
	requireGrantFault(t, RevokeGrant(t.Context(), s, p, id, in), "version_exhausted")
}
