package project

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func scopedPAT(t *testing.T, p model.Principal, ids ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	p.Kind = model.PATCredential
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}
}

func TestScopedProjectPreviewAndLifecycleAdmission(t *testing.T) {
	for _, tc := range []struct {
		name string
		run  func(*ScopedProjects, model.CredentialAuthorization, string) error
	}{
		{"transfer preview", func(s *ScopedProjects, a model.CredentialAuthorization, id string) error {
			_, err := s.TransferPreview(t.Context(), a, id, "ef000000-0000-4000-8000-000000000002")
			return err
		}},
		{"transfer", func(s *ScopedProjects, a model.CredentialAuthorization, id string) error {
			_, err := s.Transfer(t.Context(), a, id, core.TransferInput{})
			return err
		}},
		{"delete preview", func(s *ScopedProjects, a model.CredentialAuthorization, id string) error {
			_, err := s.DeletionPreview(t.Context(), a, id, model.PageRequest{Limit: 10})
			return err
		}},
		{"delete", func(s *ScopedProjects, a model.CredentialAuthorization, id string) error {
			_, err := s.Delete(t.Context(), a, id)
			return err
		}},
		{"repository preview", func(s *ScopedProjects, a model.CredentialAuthorization, id string) error {
			_, err := s.RepositoryPreview(t.Context(), a, id, "https://example.test/a", a.Principal.UserID)
			return err
		}},
		{"repository write", func(s *ScopedProjects, a model.CredentialAuthorization, id string) error {
			_, err := s.SetRepository(t.Context(), a, id, core.RepositoryChange{})
			return err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app, f := newAppLifecycleTest(t, "")
			a := scopedPAT(t, f.principal, "task:read")
			err := tc.run(NewScopedProjects(app), a, f.project.ID)
			if !errors.Is(err, scopepolicy.ErrInsufficientScope) || f.writeCalls != 0 {
				t.Fatalf("err=%v writes=%d", err, f.writeCalls)
			}
		})
	}
	t.Run("invisible", func(t *testing.T) {
		app, f := newAppLifecycleTest(t, "preflight")
		f.cause = model.ErrNotFound
		a := scopedPAT(t, f.principal, "task:read")
		_, err := NewScopedProjects(app).DeletionPreview(t.Context(), a, f.project.ID, model.PageRequest{Limit: 10})
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "not_found" || errors.Is(err, scopepolicy.ErrInsufficientScope) || f.writeCalls != 0 {
			t.Fatalf("err=%v writes=%d", err, f.writeCalls)
		}
	})
	t.Run("delete independent of project read", func(t *testing.T) {
		app, f := newAppLifecycleTest(t, "no callback")
		a := scopedPAT(t, f.principal, "project:delete")
		_, err := NewScopedProjects(app).Delete(t.Context(), a, f.project.ID)
		if errors.Is(err, scopepolicy.ErrInsufficientScope) || f.writeCalls != 1 {
			t.Fatalf("err=%v writes=%d", err, f.writeCalls)
		}
	})
}

func TestScopedCandidateSearchRechecksInsideSnapshot(t *testing.T) {
	ctx := t.Context()
	p := model.Principal{Kind: model.PATCredential, UserID: candidateActor, CredentialID: candidateTarget}
	initial := scopedPAT(t, p, "project:members")
	for _, tc := range []struct {
		name       string
		current    model.CredentialAuthorization
		wantCode   string
		wantSearch bool
	}{
		{"permitted", initial, "", true},
		{"scope removed", scopedPAT(t, p, "project:read"), "insufficient_scope", false},
		{"wrong identity", scopedPAT(t, model.Principal{UserID: candidateTarget, CredentialID: candidateActor}, "project:members"), "unauthenticated", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			scope := &candidateScope{t: t, ctx: ctx, p: p, access: model.ProjectAccess{Role: model.ProjectAdmin}}
			snapshot := &candidateSnapshot{scope: scope}
			calls := 0
			svc := NewScopedMemberships(&Memberships{store: snapshot}, func(c context.Context, actual store.SnapshotScope, principal model.Principal) (model.CredentialAuthorization, error) {
				calls++
				if c != ctx || actual != scope || principal != p {
					t.Error("callback did not receive the active snapshot and original principal")
				}
				return tc.current, nil
			})
			page, err := svc.SearchMemberCandidates(ctx, initial, candidateProject, core.CandidateSearchInput{ExpectedUserID: p.UserID, Query: "alice"})
			if calls != 1 || snapshot.calls != 1 {
				t.Fatalf("callback calls=%d snapshots=%d", calls, snapshot.calls)
			}
			if tc.wantCode != "" {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != tc.wantCode || len(page.Items) != 0 {
					t.Fatalf("page=%+v err=%v", page, err)
				}
			} else if err != nil || len(page.Items) != 1 {
				t.Fatalf("page=%+v err=%v", page, err)
			}
			searched := false
			for _, call := range scope.calls {
				if call == "search" {
					searched = true
				}
			}
			if searched != tc.wantSearch {
				t.Fatalf("calls=%v", scope.calls)
			}
		})
	}
	svc := NewScopedMemberships(&Memberships{}, nil)
	if _, err := svc.SearchMemberCandidates(ctx, initial, candidateProject, core.CandidateSearchInput{}); err == nil {
		t.Fatal("missing current authorization admitted")
	}
}

func TestScopedDirectMemberRollbackOnAuthorityChange(t *testing.T) {
	f := newMembershipFixture(t)
	owner, target := f.user(t), f.user(t)
	project := f.project(t, owner, "Scoped direct member")
	initial := model.CredentialAuthorization{Principal: owner, Profile: model.SessionProfile}
	calls := 0
	service := NewScopedDirectMembers(NewDirectMembers(f.database, directCredentialResource), func(ctx context.Context, scope store.ProjectDirectMemberScope, p model.Principal) (model.CredentialAuthorization, error) {
		calls++
		if scope == nil || p != owner {
			t.Error("callback lost transaction scope or actor")
		}
		if calls == 2 {
			return model.CredentialAuthorization{}, model.Unauthenticated(errors.New("revoked"))
		}
		return initial, nil
	})
	result, err := service.AddExistingMember(t.Context(), initial, project.ID, target.UserID, owner.UserID)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "unauthenticated" || calls != 2 || result.Added {
		t.Fatalf("result=%+v err=%v callbacks=%d", result, err, calls)
	}
	assertNoDirectGrant(t, f, project.ID, target.UserID)
}

func TestScopedRepositoryRegistrationBranches(t *testing.T) {
	ctx := t.Context()
	team := resolveTeam
	input := core.CreateProject{Name: "Repository", RepoURL: resolveAddress, TeamID: &team, ExpectedUserID: resolvePrincipal.UserID}
	for _, tc := range []struct {
		name     string
		matches  []model.Project
		scopes   []scopepolicy.ScopeID
		confirm  bool
		wantCode string
	}{
		{"read can reuse", []model.Project{resolveCandidate(candidateProject, resolveAddress)}, []scopepolicy.ScopeID{"project:read"}, false, ""},
		{"read cannot create", nil, []scopepolicy.ScopeID{"project:read"}, true, "insufficient_scope"},
		{"confirmation required", nil, []scopepolicy.ScopeID{"project:read"}, false, "invalid_input"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			plan := newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{creationMatchCall(resolvePrincipal, team, "github.com/Org/Repo", tc.matches, nil)})
			fixture := &repositoryCreationPlan{completionProjectReadPlan: plan}
			s := NewScopedProjects(&AppProjects{Projects: NewProjects(fixture)})
			got, created, err := s.RegisterRepository(ctx, scopedPAT(t, resolvePrincipal, tc.scopes...), input, tc.confirm)
			if tc.wantCode != "" {
				resolveFault(t, err, tc.wantCode)
			} else if err != nil || got.ID != candidateProject {
				t.Fatalf("got=%+v err=%v", got, err)
			}
			if created || fixture.writes != 0 {
				t.Fatalf("created=%v writes=%d", created, fixture.writes)
			}
		})
	}
}

func TestScopedInvitationAcceptanceReceipt(t *testing.T) {
	f := newMembershipFixture(t)
	owner, recipient := f.user(t), f.user(t)
	project := f.project(t, owner, "Scoped invitation")
	invitation := f.invite(t, owner, project.ID)
	actor := scopedPAT(t, recipient, "project:invitation-accept")
	svc := NewScopedMemberships(f.memberships, nil)
	_, err := svc.AcceptInvitation(t.Context(), actor, invitation.Secret, recipient.UserID)
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("full receipt without read: %v", err)
	}
	assertNoDirectGrant(t, f, project.ID, recipient.UserID)
	receipt, err := svc.AcceptInvitationReceipt(t.Context(), actor, invitation.Secret, recipient.UserID)
	if err != nil || receipt.ProjectID != project.ID || !receipt.Joined || !receipt.Consumed {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
}

func TestScopedMemberResponseReadAndRole(t *testing.T) {
	f := newMembershipFixture(t)
	owner, member := f.user(t), f.user(t)
	project := f.project(t, owner, "Scoped grant")
	joined := f.join(t, owner, member, project.ID)
	actor := scopedPAT(t, owner, "project:members")
	svc := NewScopedMemberships(f.memberships, nil)
	input := core.SetProjectGrant{Version: &joined.Grant.Version, Role: model.ProjectAdmin, ExpectedUserID: owner.UserID}
	_, err := svc.SetGrant(t.Context(), actor, project.ID, member.UserID, input)
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("full grant receipt without project read: %v", err)
	}
	if got := f.member(t, member, project.ID).Grant; got.Role != joined.Grant.Role || got.Version != joined.Grant.Version {
		t.Fatalf("grant changed before receipt admission: %+v", got)
	}
	actor = scopedPAT(t, owner, "project:members", "project:read")
	input.Version = pointer(joined.Grant.Version + 1)
	_, err = svc.SetGrant(t.Context(), actor, project.ID, member.UserID, input)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "version_conflict" {
		t.Fatalf("stale version: %v", err)
	}
	memberActor := scopedPAT(t, member, "project:members", "project:read")
	_, err = svc.SetGrant(t.Context(), memberActor, project.ID, owner.UserID, input)
	if !errors.As(err, &fault) || fault.Code != "forbidden" {
		t.Fatalf("non-admin: %v", err)
	}
}

func TestScopedRepositoryUsesProjectAdminNotTeamAdmin(t *testing.T) {
	app, f := newAppLifecycleTest(t, "")
	f.access.TeamRole = nil
	actor := scopedPAT(t, f.principal, "project:repository")
	_, err := NewScopedProjects(app).RepositoryPreview(t.Context(), actor, f.project.ID, "https://example.test/a", actor.Principal.UserID)
	if err == nil || err.Error() != "repository store unavailable" {
		t.Fatalf("project admin preflight: %v", err)
	}
}

func TestScopedTransferAndDeletionProjection(t *testing.T) {
	t.Run("transfer full receipt needs read", func(t *testing.T) {
		app, f := newAppLifecycleTest(t, "")
		actor := scopedPAT(t, f.principal, "project:transfer")
		_, err := NewScopedProjects(app).Transfer(t.Context(), actor, f.project.ID, core.TransferInput{})
		if !errors.Is(err, scopepolicy.ErrInsufficientScope) || f.writeCalls != 0 {
			t.Fatalf("err=%v writes=%d", err, f.writeCalls)
		}
	})
	for _, missing := range []scopepolicy.ScopeID{"task:read", "attachment:read", "worker:read"} {
		t.Run(string(missing), func(t *testing.T) {
			app, f := newAppLifecycleTest(t, "")
			all := []scopepolicy.ScopeID{"attachment:read", "project:delete", "task:read", "worker:read"}
			var selected []scopepolicy.ScopeID
			for _, id := range all {
				if id != missing {
					selected = append(selected, id)
				}
			}
			actor := scopedPAT(t, f.principal, selected...)
			_, err := NewScopedProjects(app).DeletionPreview(t.Context(), actor, f.project.ID, model.PageRequest{Limit: 10})
			if !errors.Is(err, scopepolicy.ErrInsufficientScope) || f.writeCalls != 0 {
				t.Fatalf("err=%v writes=%d", err, f.writeCalls)
			}
		})
	}
}

func TestScopedInvitationInspectionHasNoGrantPresenceOracle(t *testing.T) {
	f := newMembershipFixture(t)
	owner, member, recipient := f.user(t), f.user(t), f.user(t)
	project := f.project(t, owner, "Scoped inspection")
	f.join(t, owner, member, project.ID)
	invitation := f.invite(t, owner, project.ID)
	svc := NewScopedMemberships(f.memberships, nil)
	for _, principal := range []model.Principal{member, recipient} {
		actor := scopedPAT(t, principal, "project:invitation-read")
		_, err := svc.InspectInvitation(t.Context(), actor, invitation.Secret)
		if !errors.Is(err, scopepolicy.ErrInsufficientScope) {
			t.Fatalf("strict inspection: %v", err)
		}
		basic, err := svc.InspectInvitationBasic(t.Context(), actor, invitation.Secret)
		if err != nil || basic.ProjectID != project.ID || basic.ProjectName != project.Name {
			t.Fatalf("basic=%+v err=%v", basic, err)
		}
	}
}

func TestScopedTeamProjectsVisibilityAndScopes(t *testing.T) {
	f := newMembershipFixture(t)
	owner, outsider := f.user(t), f.user(t)
	project := f.project(t, owner, "Scoped team projects")
	team := project.Ownership.TeamID
	s := NewScopedProjects(&AppProjects{Projects: f.projects})
	request := core.ProjectListRequest{Page: model.PageRequest{Limit: 10}, TeamID: &team}
	_, err := s.ListScoped(t.Context(), scopedPAT(t, outsider, "project:read"), request)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "not_found" {
		t.Fatalf("invisible team: %v", err)
	}
	_, err = s.ListScoped(t.Context(), scopedPAT(t, owner, "project:read"), request)
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("missing team read: %v", err)
	}
	page, err := s.ListScoped(t.Context(), scopedPAT(t, owner, "project:read", "team:read"), request)
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != project.ID {
		t.Fatalf("page=%+v err=%v", page, err)
	}
}
