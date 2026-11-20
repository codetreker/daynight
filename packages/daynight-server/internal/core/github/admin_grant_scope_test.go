package github

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type scopedAdminFixture struct {
	adminDAOTest
	appErr, memberErr, invitationErr, availableErr error
	visibilityCalls                                int
}

func (f *scopedAdminFixture) AppAdminVisibility(context.Context, string, string) error {
	f.visibilityCalls++
	return f.appErr
}
func (f *scopedAdminFixture) AdminMembershipVisibility(context.Context, string, string) error {
	f.visibilityCalls++
	return f.memberErr
}
func (f *scopedAdminFixture) AdminInvitationVisibility(context.Context, string, string) error {
	f.visibilityCalls++
	return f.invitationErr
}
func (f *scopedAdminFixture) AvailableAdminInvitation(context.Context, []byte) (store.GitHubAdminInvitationRef, error) {
	f.visibilityCalls++
	return store.GitHubAdminInvitationRef{ID: adminInvite, AppID: adminApp, ExpiresAt: adminNow.Add(time.Hour)}, f.availableErr
}

func TestAdminAdmissionAfterVisibilityBeforeDisclosureOrMutation(t *testing.T) {
	denied := errors.New("scope denied")
	admit := func() error { return denied }
	ctx := t.Context()
	d := &scopedAdminFixture{adminDAOTest: invitationDAOTest()}
	d.invitation = func(context.Context, string, string) (githubpr.AppInvitation, error) { return normalInvitation(), nil }
	calls := []func() error{
		func() error {
			_, e := ListAdminsWithAdmission(ctx, d, adminPrincipal, adminApp, ListAppsInput{}, admit)
			return e
		},
		func() error {
			_, e := ListAdminInvitationsWithAdmission(ctx, d, adminPrincipal, adminApp, ListAppsInput{}, admit)
			return e
		},
		func() error {
			_, e := CreateAdminInvitationWithAdmission(ctx, d, adminPrincipal, adminApp, admit)
			return e
		},
		func() error {
			_, e := RevokeAdminInvitationWithAdmission(ctx, d, adminPrincipal, adminApp, adminInvite, admit)
			return e
		},
		func() error {
			_, e := RemoveAdminWithAdmission(ctx, d, adminPrincipal, adminApp, otherAdmin, 5, admit)
			return e
		},
		func() error {
			_, e := InspectAdminInvitationWithAdmission(ctx, d, adminPrincipal, "token", admit)
			return e
		},
		func() error {
			_, e := AcceptAdminInvitationWithAdmission(ctx, d, adminPrincipal, "token", admit)
			return e
		},
	}
	for i, call := range calls {
		if err := call(); !errors.Is(err, denied) {
			t.Fatalf("operation %d: %v", i, err)
		}
	}
	// Missing app remains invisible even when the policy is insufficient.
	d.appErr = model.ErrNotFound
	d.availableErr = model.ErrNotFound
	_, err := ListAdminsWithAdmission(ctx, d, adminPrincipal, adminApp, ListAppsInput{}, admit)
	faultCodeAdmin(t, err, "not_found")
	_, err = AcceptAdminInvitationWithAdmission(ctx, d, adminPrincipal, "token", admit)
	faultCodeAdmin(t, err, "invitation_unavailable")
}

type scopedImpactFixture struct{ *impactFixture }

func (f scopedImpactFixture) ImpactVisibility(_ context.Context, _ store.GitHubAppImpactQuery) (store.GitHubAppImpact, error) {
	f.queries = append(f.queries, "visibility")
	return f.summary, f.err
}

type scopedGrantReadFixture struct {
	store.GitHubGrantReadDAO
	calls []string
	err   error
}

func (f *scopedGrantReadFixture) GrantVisibility(context.Context, string, string, string, string, bool) error {
	f.calls = append(f.calls, "visibility")
	return f.err
}
func (f *scopedGrantReadFixture) Preview(context.Context, string, string, string) (store.GitHubGrantPreview, error) {
	f.calls = append(f.calls, "preview")
	return store.GitHubGrantPreview{}, nil
}
func (f *scopedGrantReadFixture) Grant(context.Context, string, string, string) (store.GitHubTeamGrant, error) {
	f.calls = append(f.calls, "grant")
	return store.GitHubTeamGrant{}, nil
}
func (f *scopedGrantReadFixture) Grants(context.Context, string, string, *string, int) (store.GitHubGrantPage, error) {
	f.calls = append(f.calls, "grants")
	return store.GitHubGrantPage{}, nil
}
func (f *scopedGrantReadFixture) TeamApps(context.Context, string, string, *string, int) (store.GitHubTeamAppPage, error) {
	f.calls = append(f.calls, "teamApps")
	return store.GitHubTeamAppPage{}, nil
}

func (s *grantWriteStub) GrantWriteAdmission(context.Context, string) (store.GitHubGrantWriteAdmission, error) {
	s.steps = append(s.steps, "admission")
	return store.GitHubGrantWriteAdmission{TeamID: s.facts.Team.ID, TeamVersion: s.facts.Team.Version, AppVersion: s.facts.AppVersion, ImpactVersion: s.facts.ImpactVersion, IsAdmin: s.facts.IsAdmin}, nil
}

func (s *grantWriteStub) RequireLiveGrant(context.Context, string) error {
	s.steps = append(s.steps, "visible grant")
	if s.current == nil {
		return model.ErrNotFound
	}
	return nil
}

func TestGrantAdmissionBeforeWritesAndImpactDisclosure(t *testing.T) {
	ctx := t.Context()
	actor, teamID := uuid.NewString(), uuid.NewString()
	p := model.Principal{Kind: model.PATCredential, UserID: actor, CredentialID: uuid.NewString()}
	facts := store.GitHubGrantFacts{Team: store.GitHubGrantTeam{TeamRef: model.TeamRef{ID: teamID}, Version: 3}, AppVersion: 2, ImpactVersion: 4, IsAdmin: true}
	denied := errors.New("scope denied")
	admit := func() error { return denied }
	in := CreateGrantInput{ID: uuid.NewString(), TeamID: teamID, ExpectedUserID: actor, Version: 2, TeamVersion: 3}
	f := &grantWriteStub{facts: facts}
	_, err := CreateGrantWithAdmission(ctx, f, p, in, admit)
	if !errors.Is(err, denied) || !reflect.DeepEqual(f.steps, []string{"admission"}) {
		t.Fatalf("create %v %v", err, f.steps)
	}
	f.steps = nil
	f.current = &store.GitHubTeamGrant{ID: in.ID}
	err = RevokeGrantWithAdmission(ctx, f, p, in.ID, RevokeGrantInput{ExpectedUserID: actor, Version: 2, ImpactVersion: 4}, admit)
	if !errors.Is(err, denied) || !reflect.DeepEqual(f.steps, []string{"admission", "visible grant"}) {
		t.Fatalf("revoke %v %v", err, f.steps)
	}
	f.facts.IsAdmin = false
	f.steps = nil
	_, err = CreateGrantWithAdmission(ctx, f, p, in, admit)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "not_found" {
		t.Fatalf("role: %v", err)
	}
	impact := scopedImpactFixture{&impactFixture{summary: store.GitHubAppImpact{Version: 2, ImpactVersion: 4}}}
	_, err = ReadAppImpactWithAdmission(ctx, impact, p, AppImpactInput{AppID: uuid.NewString()}, admit)
	if !errors.Is(err, denied) || !reflect.DeepEqual(impact.queries, []string{"visibility"}) {
		t.Fatalf("impact %v %v", err, impact.queries)
	}
	impact.summary.GrantMissing = true
	_, err = ReadAppImpactProjectsWithAdmission(ctx, impact, p, AppImpactInput{AppID: uuid.NewString()}, admit)
	if !errors.As(err, &fault) || fault.Code != "not_found" {
		t.Fatalf("missing grant: %v", err)
	}
}

func TestMissingTargetsPrecedeScopeDenial(t *testing.T) {
	ctx := t.Context()
	admitCalls := 0
	admit := func() error { admitCalls++; return errors.New("scope denied") }
	d := &scopedAdminFixture{adminDAOTest: normalAdminDAO(), memberErr: model.ErrNotFound}
	_, err := RemoveAdminWithAdmission(ctx, d, adminPrincipal, adminApp, otherAdmin, 5, admit)
	faultCodeAdmin(t, err, "not_found")
	d.invitationErr = model.ErrNotFound
	_, err = RevokeAdminInvitationWithAdmission(ctx, d, adminPrincipal, adminApp, adminInvite, admit)
	faultCodeAdmin(t, err, "not_found")
	f := &grantWriteStub{facts: store.GitHubGrantFacts{IsAdmin: true, AppVersion: 1, ImpactVersion: 1}}
	err = RevokeGrantWithAdmission(ctx, f, adminPrincipal, adminInvite, RevokeGrantInput{ExpectedUserID: adminPrincipal.UserID, Version: 1, ImpactVersion: 1}, admit)
	faultCodeAdmin(t, err, "github_grant_changed")
	if admitCalls != 0 || !reflect.DeepEqual(f.steps, []string{"admission", "visible grant"}) {
		t.Fatalf("calls %d, grant operations %v", admitCalls, f.steps)
	}
}

func TestImpactVersionConflictPrecedesMissingGrant(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	appID, grantID := uuid.NewString(), uuid.NewString()
	fixture := &impactFixture{summary: store.GitHubAppImpact{Version: 2, ImpactVersion: 3}, teams: store.GitHubAppImpactTeams{Items: []store.GitHubAppImpactTeam{{Team: model.TeamRef{ID: uuid.NewString()}}}, HasMore: true}}
	page, err := ReadAppImpact(t.Context(), fixture, p, AppImpactInput{AppID: appID, GrantID: &grantID, Limit: 1})
	if err != nil || page.NextCursor == nil {
		t.Fatalf("prepare: %v", err)
	}
	fixture.summary.Version++
	fixture.summary.GrantMissing = true
	_, err = ReadAppImpact(t.Context(), fixture, p, AppImpactInput{AppID: appID, GrantID: &grantID, Cursor: *page.NextCursor})
	faultCodeAdmin(t, err, "version_conflict")
}

func TestGrantReadsCheckVisibilityBeforeScopeWithoutReadingContent(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	app, id := uuid.NewString(), uuid.NewString()
	denied := errors.New("scope denied")
	for _, call := range []func(*scopedGrantReadFixture) error{
		func(f *scopedGrantReadFixture) error {
			_, e := PreviewGrantWithAdmission(t.Context(), f, p, app, id, func() error { return denied })
			return e
		},
		func(f *scopedGrantReadFixture) error {
			_, e := GetGrantWithAdmission(t.Context(), f, p, app, id, func() error { return denied })
			return e
		},
		func(f *scopedGrantReadFixture) error {
			_, e := ListGrantsWithAdmission(t.Context(), f, p, app, model.PageRequest{}, func() error { return denied })
			return e
		},
		func(f *scopedGrantReadFixture) error {
			_, e := ListTeamAppsWithAdmission(t.Context(), f, p, id, model.PageRequest{}, func() error { return denied })
			return e
		},
	} {
		f := &scopedGrantReadFixture{}
		if err := call(f); !errors.Is(err, denied) || !reflect.DeepEqual(f.calls, []string{"visibility"}) {
			t.Fatalf("denial %v %v", err, f.calls)
		}
		f.calls = nil
		f.err = model.ErrNotFound
		faultCodeAdmin(t, call(f), "not_found")
		if !reflect.DeepEqual(f.calls, []string{"visibility"}) {
			t.Fatal(f.calls)
		}
	}
}

func TestScopedAdminDeniedBeforeFullContentReads(t *testing.T) {
	d := &scopedAdminFixture{adminDAOTest: invitationDAOTest()}
	content := 0
	d.app = func(context.Context, string) (githubpr.AppIdentity, error) {
		content++
		return githubpr.AppIdentity{}, nil
	}
	d.member = func(context.Context, string, string) (githubpr.AdminMembership, error) {
		content++
		return githubpr.AdminMembership{}, nil
	}
	d.invitation = func(context.Context, string, string) (githubpr.AppInvitation, error) {
		content++
		return githubpr.AppInvitation{}, nil
	}
	deny := func() error { return errors.New("scope denied") }
	calls := []func(){
		func() {
			_, _ = ListAdminsWithAdmission(t.Context(), d, adminPrincipal, adminApp, ListAppsInput{}, deny)
		},
		func() { _, _ = CreateAdminInvitationWithAdmission(t.Context(), d, adminPrincipal, adminApp, deny) },
		func() {
			_, _ = RevokeAdminInvitationWithAdmission(t.Context(), d, adminPrincipal, adminApp, adminInvite, deny)
		},
		func() { _, _ = RemoveAdminWithAdmission(t.Context(), d, adminPrincipal, adminApp, otherAdmin, 5, deny) },
		func() { _, _ = InspectAdminInvitationWithAdmission(t.Context(), d, adminPrincipal, "token", deny) },
		func() { _, _ = AcceptAdminInvitationWithAdmission(t.Context(), d, adminPrincipal, "token", deny) },
	}
	for _, call := range calls {
		call()
	}
	if content != 0 || d.visibilityCalls == 0 {
		t.Fatalf("full content reads %d, visibility %d", content, d.visibilityCalls)
	}
}
