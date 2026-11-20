package team

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func scopeAuth(t *testing.T, scopes ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	p := principal()
	p.Kind = model.PATCredential
	ids, err := scopepolicy.Normalize(scopepolicy.PAT, scopes)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}
}
func scopeContext(a model.CredentialAuthorization) context.Context {
	return WithScopeCheck(context.Background(), func(_ context.Context, p model.Principal, ops ...scopepolicy.Operation) error {
		if p != a.Principal {
			return errors.New("incorrect principal")
		}
		return RequireScope(a, ops...)
	})
}
func TestTeamScopeProfilesAndDefaults(t *testing.T) {
	entries, err := scopepolicy.Catalog(scopepolicy.PAT)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]scopepolicy.ScopeID, 0, len(entries))
	for _, e := range entries {
		ids = append(ids, e.ID)
	}
	defaults, err := scopepolicy.Defaults(scopepolicy.PAT, ids)
	if err != nil {
		t.Fatal(err)
	}
	auth := scopeAuth(t, defaults...)
	if err := RequireScope(auth, scopepolicy.TeamRead); err != nil {
		t.Fatal(err)
	}
	for _, op := range []scopepolicy.Operation{scopepolicy.TeamWrite, scopepolicy.TeamMembers, scopepolicy.TeamInvitations, scopepolicy.TeamInvitationRead, scopepolicy.TeamInvitationAccept, scopepolicy.TeamLeave, scopepolicy.TeamDelete} {
		faultCode(t, RequireScope(auth, op), "insufficient_scope")
	}
	session := principal()
	if err := RequireScope(model.CredentialAuthorization{Principal: session, Profile: model.SessionProfile}, scopepolicy.TeamWrite); err != nil {
		t.Fatal(err)
	}
	if err := RequireScope(model.CredentialAuthorization{Principal: auth.Principal, Profile: model.ScopedPATProfile}, scopepolicy.TeamRead); err == nil {
		t.Fatal("missing scope policy accepted")
	}
	if err := RequireScope(auth, scopepolicy.Operation("unknown")); err == nil {
		t.Fatal("unknown operation accepted")
	}
}
func TestScopeRetainsTeamVisibilityAndRole(t *testing.T) {
	auth := scopeAuth(t, "team:read")
	ctx := scopeContext(auth)
	p := auth.Principal
	team := namedTeam(p)
	w := &writerFake{team: team, errs: map[string]error{}}
	input := ChangeTeam{Name: "new", Version: team.Version, ExpectedUserID: p.UserID}
	_, err := Rename(ctx, w, p, input)
	faultCode(t, err, "insufficient_scope")
	if w.renameCalls != 0 {
		t.Fatal("rename reached DAO")
	}
	w.team.Membership.Role = model.ProjectMemberRole
	_, err = Rename(ctx, w, p, input)
	faultCode(t, err, "forbidden")
	w.errs["team"] = model.ErrNotFound
	_, err = Rename(ctx, w, p, input)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing Team: %v", err)
	}
}
func TestTeamInvitationAcceptHasIndependentScope(t *testing.T) {
	now := time.Now()
	auth := scopeAuth(t, "team:invitation-accept")
	p := auth.Principal
	team := namedTeam(p)
	w := &writerFake{team: team, ref: team.TeamRef, invitation: model.TeamInvitation{ID: "id", ExpiresAt: now.Add(time.Hour)}, errs: map[string]error{"inviteMember": model.ErrNotFound}}
	_, err := AcceptInvitationReceipt(scopeContext(auth), w, p, "secret", func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	if !w.added || !w.consumed {
		t.Fatal("accept did not perform both writes")
	}
	strict := &writerFake{ref: team.TeamRef, invitation: model.TeamInvitation{ExpiresAt: now.Add(time.Hour)}, errs: map[string]error{}}
	_, err = AcceptInvitation(scopeContext(auth), strict, p, "secret", func() time.Time { return now })
	faultCode(t, err, "insufficient_scope")
	if strict.added || strict.consumed {
		t.Fatal("strict response without read performed writes")
	}
	readOnly := scopeAuth(t, "team:read")
	w = &writerFake{ref: team.TeamRef, invitation: model.TeamInvitation{ExpiresAt: now.Add(time.Hour)}, errs: map[string]error{}}
	_, err = AcceptInvitation(scopeContext(readOnly), w, readOnly.Principal, "secret", func() time.Time { return now })
	faultCode(t, err, "insufficient_scope")
	if w.added || w.consumed {
		t.Fatal("denied acceptance performed writes")
	}
}
func TestTeamMemberLeaveAndAdminScopes(t *testing.T) {
	auth := scopeAuth(t, "team:leave")
	p := auth.Principal
	team := namedTeam(p)
	team.Membership.Role = model.ProjectMemberRole
	w := &writerFake{team: team, member: model.TeamMember{UserID: p.UserID, Role: model.ProjectMemberRole, Version: 1}, errs: map[string]error{}}
	_, err := ChangeMember(scopeContext(auth), w, p, p.UserID, ChangeTeamMember{Version: 1}, true)
	if err != nil || !w.removed {
		t.Fatalf("leave: %v", err)
	}
	w.removed = false
	_, err = ChangeMember(scopeContext(auth), w, p, "other", ChangeTeamMember{Version: 1}, true)
	faultCode(t, err, "forbidden")
	if w.removed {
		t.Fatal("member removed another user")
	}
	w.team.Membership.Role = model.ProjectAdmin
	_, err = ChangeMember(scopeContext(auth), w, p, "other", ChangeTeamMember{Version: 1}, true)
	faultCode(t, err, "insufficient_scope")
	if w.removed {
		t.Fatal("missing member scope removed user")
	}
}

type scopedMemberReader struct {
	store.TeamReader
	memberErr   error
	memberCalls int
}

func (r *scopedMemberReader) TeamAccess(context.Context, string, string) error { return nil }
func (r *scopedMemberReader) InvitationTeamMember(context.Context, string, string) (model.TeamMember, error) {
	r.memberCalls++
	return model.TeamMember{}, r.memberErr
}
func TestMemberScopeDenialDoesNotRevealTargetExistence(t *testing.T) {
	auth := scopeAuth(t, "team:write")
	for _, memberErr := range []error{nil, model.ErrNotFound} {
		reader := &scopedMemberReader{memberErr: memberErr}
		_, err := Member(scopeContext(auth), reader, auth.Principal, "team", "member")
		faultCode(t, err, "insufficient_scope")
		if reader.memberCalls != 0 {
			t.Fatal("target membership queried without read permission")
		}
	}
}
