package project

import (
	"context"
	"strings"
	"testing"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func TestMembershipExpectedActorRejectsBeforeDomainSQL(t *testing.T) {
	actor, target := projectProjectionPrincipal(1), projectProjectionPrincipal(2)
	memberships := NewMemberships(projectValidationStore{})
	ctx := t.Context()
	const version int64 = 1
	grant, err := memberships.SetRole(ctx, actor, grantActorProject, target.UserID, coreproject.SetProjectMemberRole{
		Version: version, Role: model.ProjectAdmin, ExpectedUserID: target.UserID,
	})
	requireFault(t, err, "identity_mismatch")
	if grant != (model.ProjectGrant{}) {
		t.Fatalf("identity mismatch returned a grant: %#v", grant)
	}
	err = memberships.Remove(ctx, actor, grantActorProject, target.UserID, coreproject.RemoveProjectMember{
		Version: version, ExpectedUserID: target.UserID,
	})
	requireFault(t, err, "identity_mismatch")
}

func TestMembershipExpectedActorRequiresCanonicalIdentity(t *testing.T) {
	ctx := context.Background()
	actor := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	projectID, targetID := uuid.NewString(), uuid.NewString()
	memberships := NewMemberships(nil)
	for _, expected := range []string{"", "invalid", strings.ToUpper("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")} {
		_, err := memberships.SetRole(ctx, actor, projectID, targetID, coreproject.SetProjectMemberRole{Version: 1, Role: model.ProjectAdmin, ExpectedUserID: expected})
		requireFault(t, err, "invalid_input")
		err = memberships.Remove(ctx, actor, projectID, targetID, coreproject.RemoveProjectMember{Version: 1, ExpectedUserID: expected})
		requireFault(t, err, "invalid_input")
	}
}

func TestInvitationExpectedActorRejectsBeforeDomainStore(t *testing.T) {
	principal := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	memberships := NewMemberships(nil)
	projectID, invitationID, other := uuid.NewString(), uuid.NewString(), uuid.NewString()
	_, err := memberships.CreateInvitation(t.Context(), principal, projectID, other)
	requireFault(t, err, "identity_mismatch")
	err = memberships.RevokeInvitation(t.Context(), principal, projectID, invitationID, other)
	requireFault(t, err, "identity_mismatch")
	_, err = memberships.AcceptInvitation(t.Context(), principal, "dninvite_"+strings.Repeat("a", 43), other)
	requireFault(t, err, "identity_mismatch")
}
