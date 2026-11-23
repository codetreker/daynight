package github

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func (d adminServiceDAO) AppAdminVisibility(context.Context, string, string) error { return d.err }
func (d adminServiceDAO) AdminMembershipVisibility(context.Context, string, string) error {
	return d.err
}
func (d adminServiceDAO) AdminInvitationVisibility(context.Context, string, string) error {
	return d.err
}
func (d adminServiceDAO) AvailableAdminInvitation(context.Context, []byte) (store.GitHubAdminInvitationRef, error) {
	return store.GitHubAdminInvitationRef{ID: svcAdminInvite, AppID: svcAdminApp, ExpiresAt: time.Now().Add(time.Hour)}, d.err
}

func (d adminServiceDAO) CurrentAdminAuthorization(_ context.Context, p model.Principal) (model.CredentialAuthorization, error) {
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"github:manage", "github:read"}, 1)
	return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}, err
}

func adminPolicy(t *testing.T, scopes ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: svcAdminUser, CredentialID: svcAdminUser}, Profile: model.ScopedPATProfile, Policy: &policy}
}
func scopeFault(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}
func TestScopedAdminServiceAdmitsActualOperations(t *testing.T) {
	reads, writes := 0, 0
	m := NewAdminManager(serviceAdminStore(t, adminServiceDAO{}, &reads, &writes))
	ctx := t.Context()
	read := adminPolicy(t, "github:read")
	manage := adminPolicy(t, "github:manage")
	both := adminPolicy(t, "github:manage", "github:read")
	token := secretutil.Random("dn_gai_")
	if _, err := m.ListAdminsAuthorized(ctx, read, svcAdminApp, core.ListAppsInput{}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.ListAdminInvitationsAuthorized(ctx, read, svcAdminApp, core.ListAppsInput{}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.InspectAdminInvitationAuthorized(ctx, read, token); err != nil {
		t.Fatal(err)
	}
	_, err := m.ListAdminInvitationsAuthorized(ctx, manage, svcAdminApp, core.ListAppsInput{})
	scopeFault(t, err, "insufficient_scope")
	_, err = m.InspectAdminInvitationAuthorized(ctx, manage, token)
	scopeFault(t, err, "insufficient_scope")
	_, err = m.CreateAdminInvitationAuthorized(ctx, read, svcAdminApp, svcAdminUser)
	scopeFault(t, err, "insufficient_scope")
	_, err = m.RemoveAdminAuthorized(ctx, read, svcAdminApp, svcAdminUser, core.RemoveAdminInput{ExpectedUserID: svcAdminUser, MembershipVersion: 5})
	scopeFault(t, err, "insufficient_scope")
	_, err = m.RevokeAdminInvitationAuthorized(ctx, manage, svcAdminApp, svcAdminInvite, svcAdminUser)
	scopeFault(t, err, "insufficient_scope")
	if _, err = m.RevokeAdminInvitationAuthorized(ctx, both, svcAdminApp, svcAdminInvite, svcAdminUser); err != nil {
		t.Fatal(err)
	}
	_, err = m.AcceptAdminInvitationAuthorized(ctx, manage, token, svcAdminUser)
	scopeFault(t, err, "insufficient_scope")
	if _, err = m.AcceptAdminInvitationAuthorized(ctx, both, token, svcAdminUser); err != nil {
		t.Fatal(err)
	}
	_, err = m.CreateAdminInvitationAuthorized(ctx, manage, svcAdminApp, svcAdminUser)
	scopeFault(t, err, "insufficient_scope")
	if _, err = m.CreateAdminInvitationAuthorized(ctx, both, svcAdminApp, svcAdminUser); err != nil {
		t.Fatal(err)
	}
	invalid := read
	invalid.Policy = nil
	before := reads + writes
	if _, err = m.ListAdminsAuthorized(ctx, invalid, svcAdminApp, core.ListAppsInput{}); err == nil || reads+writes != before {
		t.Fatalf("invalid policy %v", err)
	}
	fixed := model.CredentialAuthorization{Principal: model.Principal{Kind: model.SessionCredential, UserID: svcAdminUser, CredentialID: svcAdminUser}, Profile: model.SessionProfile}
	if _, err = m.ListAdminsAuthorized(ctx, fixed, svcAdminApp, core.ListAppsInput{}); err != nil {
		t.Fatalf("session %v", err)
	}
}
