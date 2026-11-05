package project

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

const InvitationLifetime = 7 * 24 * time.Hour
const invitationPrefix = "dninvite_"

type ProjectParticipants struct {
	Items       []model.ProjectParticipant
	ActorAccess model.ProjectAccess
}
type SetProjectMemberRole struct {
	Version        int64
	Role           model.ProjectRole
	ExpectedUserID string
}
type RemoveProjectMember struct {
	Version        int64
	ExpectedUserID string
}
type SetProjectGrant struct {
	Version        *int64
	Role           model.ProjectRole
	ExpectedUserID string
}
type SetGrantResult struct {
	Grant       model.ProjectGrant
	ActorAccess *model.ProjectAccess
}
type RemoveGrantResult struct {
	ProjectID, UserID string
	ActorAccess       *model.ProjectAccess
}
type MintedInvitation struct {
	Invitation model.ProjectInvitation
	Secret     string
}
type InvitationInspection struct {
	ProjectID, ProjectName string
	DirectGrant            *model.ProjectGrant
	Access                 *model.ProjectAccess
}
type InvitationAcceptance struct {
	ProjectID        string
	DirectGrant      model.ProjectGrant
	Access           model.ProjectAccess
	Joined, Consumed bool
}

func ValidateMemberActor(p model.Principal, expected string) error {
	if err := model.RequirePrincipal(p); err != nil {
		return err
	}
	id, err := model.CanonicalID(expected)
	if err != nil {
		return err
	}
	if id != expected {
		return invalidInput("expectedUserId must be a canonical user UUID")
	}
	if id != p.UserID {
		return &model.Fault{Code: "identity_mismatch", Message: "The signed-in account changed. Review the project authorization again."}
	}
	return nil
}
func ValidateMemberMutation(user string, version int64) (string, error) {
	id, err := model.CanonicalID(user)
	if err != nil {
		return "", err
	}
	if version < 1 {
		return "", invalidInput("Version must be a positive integer.")
	}
	return id, nil
}
func ValidateRole(role model.ProjectRole) error {
	if role != model.ProjectAdmin && role != model.ProjectMemberRole {
		return invalidInput("Role must be admin or member.")
	}
	return nil
}
func ValidateSetGrant(p model.Principal, user string, input SetProjectGrant) (string, error) {
	if err := ValidateMemberActor(p, input.ExpectedUserID); err != nil {
		return "", err
	}
	id, err := model.CanonicalID(user)
	if err != nil {
		return "", err
	}
	if input.Version != nil && *input.Version < 1 {
		return "", invalidInput("Version must be null or a positive integer.")
	}
	if err = ValidateRole(input.Role); err != nil {
		return "", err
	}
	return id, nil
}
func ListParticipants(ctx context.Context, dao store.ProjectReader, id string, access model.ProjectAccess) (ProjectParticipants, error) {
	items, err := dao.ProjectParticipants(ctx, id)
	return ProjectParticipants{Items: items, ActorAccess: access}, err
}
func memberMutationTarget(ctx context.Context, dao store.ProjectWriteDAO, user string, version int64) (model.ProjectMember, error) {
	member, err := dao.DirectProjectMember(ctx, user)
	if errors.Is(err, model.ErrNotFound) {
		return model.ProjectMember{}, &model.Fault{Code: "not_found", Message: "Project member was not found.", Cause: err}
	}
	if err != nil {
		return model.ProjectMember{}, err
	}
	if member.Grant.Version != version {
		return model.ProjectMember{}, &model.Fault{Code: "version_conflict", Message: "Member version does not match."}
	}
	return member, nil
}
func SetRole(ctx context.Context, dao store.ProjectWriteDAO, user string, input SetProjectMemberRole) (model.ProjectGrant, error) {
	member, err := memberMutationTarget(ctx, dao, user, input.Version)
	if err != nil {
		return model.ProjectGrant{}, err
	}
	if member.Grant.Role == input.Role {
		return member.Grant, nil
	}
	member, err = dao.SetMemberRole(ctx, user, input.Role)
	return member.Grant, err
}
func Remove(ctx context.Context, dao store.ProjectWriteDAO, user string, input RemoveProjectMember) error {
	if _, err := memberMutationTarget(ctx, dao, user, input.Version); err != nil {
		return err
	}
	return dao.RemoveMember(ctx, user)
}
func grantConflict() error {
	return &model.Fault{Code: "version_conflict", Message: "Project grant version does not match."}
}
func actorGrantAccess(ctx context.Context, dao store.ProjectWriteDAO, p model.Principal) (*model.ProjectAccess, error) {
	access, err := dao.ProjectAccess(ctx, p)
	if errors.Is(err, model.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &access, nil
}
func SetGrant(ctx context.Context, dao store.ProjectWriteDAO, p model.Principal, user string, input SetProjectGrant) (SetGrantResult, error) {
	var result SetGrantResult
	grant, err := dao.DirectGrant(ctx, user)
	if err != nil && !errors.Is(err, model.ErrNotFound) {
		return result, err
	}
	exists := err == nil
	if input.Version == nil {
		if exists {
			return result, grantConflict()
		}
		if _, err := dao.ProjectAccess(ctx, model.Principal{UserID: user}); err != nil {
			if errors.Is(err, model.ErrNotFound) {
				return result, &model.Fault{Code: "not_found", Message: "Project participant was not found.", Cause: err}
			}
			return result, err
		}
		grant, err = dao.CreateGrant(ctx, user, input.Role)
	} else {
		if !exists || grant.Version != *input.Version {
			return result, grantConflict()
		}
		if grant.Role != input.Role {
			member, updateErr := dao.SetMemberRole(ctx, user, input.Role)
			grant, err = member.Grant, updateErr
		}
	}
	if err != nil {
		return result, err
	}
	result.Grant = grant
	result.ActorAccess, err = actorGrantAccess(ctx, dao, p)
	return result, err
}
func RemoveGrant(ctx context.Context, dao store.ProjectWriteDAO, p model.Principal, projectID, user string, input RemoveProjectMember) (RemoveGrantResult, error) {
	result := RemoveGrantResult{ProjectID: projectID, UserID: user}
	grant, err := dao.DirectGrant(ctx, user)
	if err != nil && !errors.Is(err, model.ErrNotFound) {
		return result, err
	}
	if err != nil || grant.Version != input.Version {
		return result, grantConflict()
	}
	if err := dao.RemoveMember(ctx, user); err != nil {
		return result, err
	}
	result.ActorAccess, err = actorGrantAccess(ctx, dao, p)
	return result, err
}
func CreateInvitation(ctx context.Context, dao store.ProjectWriteDAO, p model.Principal, id string, now func() time.Time) (MintedInvitation, error) {
	observed := now().UTC()
	result := MintedInvitation{Secret: secretutil.Random(invitationPrefix)}
	result.Invitation = model.ProjectInvitation{ID: uuid.NewString(), ProjectID: id, CreatedBy: p.UserID, TokenHash: secretutil.Hash(result.Secret), CreatedAt: observed, ExpiresAt: observed.Add(InvitationLifetime)}
	if err := dao.CreateInvitation(ctx, result.Invitation); err != nil {
		return MintedInvitation{}, err
	}
	result.Invitation.TokenHash = nil
	return result, nil
}
func ListInvitations(ctx context.Context, dao store.ProjectReader, id string, now func() time.Time) ([]model.ProjectInvitation, error) {
	return dao.Invitations(ctx, id, now().UTC())
}
func RevokeInvitation(ctx context.Context, dao store.ProjectWriteDAO, id string, now func() time.Time) error {
	return dao.RevokeInvitation(ctx, id, now().UTC())
}
func ValidateInvitation(p model.Principal, secret string) error {
	if err := model.RequirePrincipal(p); err != nil {
		return err
	}
	if !secretutil.Valid(secret, invitationPrefix) {
		return model.InvitationUnavailable(nil)
	}
	return nil
}
func invitationAvailable(i model.ProjectInvitation, now time.Time) bool {
	return i.ConsumedAt == nil && i.RevokedAt == nil && i.ExpiresAt.After(now)
}
func Invitation(ctx context.Context, dao store.ProjectReader, secret string, now func() time.Time) (model.ProjectInvitation, error) {
	i, err := dao.Invitation(ctx, secretutil.Hash(secret))
	if errors.Is(err, model.ErrNotFound) {
		return model.ProjectInvitation{}, model.InvitationUnavailable(err)
	}
	if err != nil {
		return model.ProjectInvitation{}, err
	}
	if !invitationAvailable(i, now().UTC()) {
		return model.ProjectInvitation{}, model.InvitationUnavailable(nil)
	}
	return i, nil
}
func InspectInvitation(ctx context.Context, dao store.ProjectReader, p model.Principal, i model.ProjectInvitation) (InvitationInspection, error) {
	var result InvitationInspection
	value, err := dao.Project(ctx, i.ProjectID)
	if errors.Is(err, model.ErrNotFound) {
		return result, model.InvitationUnavailable(err)
	}
	if err != nil {
		return result, err
	}
	result.ProjectID, result.ProjectName = value.ID, value.Name
	access, err := dao.ProjectAccess(ctx, p, value.ID)
	if errors.Is(err, model.ErrNotFound) {
		return result, nil
	}
	if err == nil {
		result.Access = &access
		result.DirectGrant = access.DirectGrant
	}
	return result, err
}
func AcceptInvitation(ctx context.Context, dao store.ProjectWriteDAO, p model.Principal, id, secret string, now func() time.Time) (InvitationAcceptance, error) {
	var result InvitationAcceptance
	i, err := dao.LockInvitation(ctx, secretutil.Hash(secret))
	if errors.Is(err, model.ErrNotFound) {
		return result, model.InvitationUnavailable(err)
	}
	if err != nil {
		return result, err
	}
	observed := now().UTC()
	if !invitationAvailable(i, observed) {
		return result, model.InvitationUnavailable(nil)
	}
	member, err := dao.DirectProjectMember(ctx, p.UserID)
	if err != nil && !errors.Is(err, model.ErrNotFound) {
		return result, err
	}
	if errors.Is(err, model.ErrNotFound) {
		member, err = dao.AddInvitedMember(ctx, p.UserID)
		if err != nil {
			return result, err
		}
		if err = dao.ConsumeInvitation(ctx, i.ID, p.UserID, observed); err != nil {
			return result, err
		}
		result.Joined, result.Consumed = true, true
	}
	result.ProjectID, result.DirectGrant = id, member.Grant
	result.Access, err = dao.ProjectAccess(ctx, p)
	return result, err
}
