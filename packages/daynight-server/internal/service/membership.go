package service

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

const InvitationLifetime = 7 * 24 * time.Hour
const invitationPrefix = "dninvite_"

type Memberships struct {
	store *store.Store
	now   func() time.Time
}

func NewMemberships(database *store.Store) *Memberships {
	return &Memberships{store: database, now: time.Now}
}

type MintedInvitation struct {
	Invitation model.ProjectInvitation
	Secret     string
}

type InvitationInspection struct {
	ProjectID   string
	ProjectName string
	DirectGrant *model.ProjectGrant
	Access      *model.ProjectAccess
}

type InvitationAcceptance struct {
	ProjectID   string
	DirectGrant model.ProjectGrant
	Access      model.ProjectAccess
	Joined      bool
	Consumed    bool
}

func projectNotFound(cause error) error {
	return &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: cause}
}

func membershipLookupError(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return projectNotFound(err)
	}
	return err
}

func RequireProjectRead(ctx context.Context, reader store.ProjectReader, principal model.Principal, projectID string) (model.ProjectAccess, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.ProjectAccess{}, err
	}
	id, err := model.CanonicalID(projectID)
	if err != nil {
		return model.ProjectAccess{}, err
	}
	access, err := reader.ProjectAccess(ctx, principal, id)
	return access, membershipLookupError(err)
}

func RequireProjectWrite(ctx context.Context, tx *store.ProjectTx, principal model.Principal) (model.ProjectAccess, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.ProjectAccess{}, err
	}
	access, err := tx.ProjectAccess(ctx, principal)
	return access, membershipLookupError(err)
}

func requireProjectAdmin(access model.ProjectAccess) error {
	if access.Role != model.ProjectAdmin {
		return &model.Fault{Code: "forbidden", Message: "Project administrator access is required."}
	}
	return nil
}

func (s *Memberships) read(ctx context.Context, principal model.Principal, projectID string, admin bool, operation func(store.ProjectReader, model.ProjectAccess) error) error {
	if err := model.RequirePrincipal(principal); err != nil {
		return err
	}
	id, err := model.CanonicalID(projectID)
	if err != nil {
		return err
	}
	var refusal *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		return completion.Capture(func() error {
			access, err := RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, id)
			if err != nil {
				return err
			}
			if admin {
				if err := requireProjectAdmin(access); err != nil {
					return err
				}
			}
			return operation(snapshot.ProjectDAO(), access)
		}, &refusal)
	})
	if err != nil {
		return err
	}
	if refusal != nil {
		return refusal
	}
	return nil
}

func (s *Memberships) write(ctx context.Context, principal model.Principal, projectID string, operation func(*store.ProjectTx) error) error {
	if err := model.RequirePrincipal(principal); err != nil {
		return err
	}
	id, err := model.CanonicalID(projectID)
	if err != nil {
		return err
	}
	var refusal *model.Fault
	err = s.store.WriteProject(ctx, id, func(tx *store.ProjectTx) error {
		return completion.Capture(func() error {
			access, err := RequireProjectWrite(ctx, tx, principal)
			if err != nil {
				return err
			}
			if err := requireProjectAdmin(access); err != nil {
				return err
			}
			return operation(tx)
		}, &refusal)
	})
	if err != nil {
		return membershipLookupError(err)
	}
	if refusal != nil {
		return refusal
	}
	return nil
}

type ProjectParticipants struct {
	Items       []model.ProjectParticipant
	ActorAccess model.ProjectAccess
}

func (s *Memberships) List(ctx context.Context, principal model.Principal, projectID string) ([]model.ProjectParticipant, error) {
	result, err := s.ListWithAccess(ctx, principal, projectID)
	return result.Items, err
}

func (s *Memberships) ListWithAccess(ctx context.Context, principal model.Principal, projectID string) (ProjectParticipants, error) {
	var result ProjectParticipants
	err := s.read(ctx, principal, projectID, false, func(reader store.ProjectReader, access model.ProjectAccess) error {
		var err error
		result.ActorAccess = access
		result.Items, err = reader.ProjectParticipants(ctx, projectID)
		return err
	})
	if err != nil {
		return ProjectParticipants{}, err
	}
	return result, nil
}

func memberMutationTarget(ctx context.Context, tx *store.ProjectTx, userID string, version int64) (model.ProjectMember, error) {
	member, err := tx.DirectProjectMember(ctx, userID)
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

func validateMemberMutation(userID string, version int64) (string, error) {
	id, err := model.CanonicalID(userID)
	if err != nil {
		return "", err
	}
	if version < 1 {
		return "", invalidInput("Version must be a positive integer.")
	}
	return id, nil
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

func requireMembershipActor(principal model.Principal, expectedUserID string) error {
	expected, err := model.CanonicalID(expectedUserID)
	if err != nil {
		return err
	}
	if expected != expectedUserID {
		return invalidInput("expectedUserId must be a canonical user UUID")
	}
	if expected != principal.UserID {
		return &model.Fault{Code: "identity_mismatch", Message: "The signed-in account changed. Review the project authorization again."}
	}
	return nil
}

func (s *Memberships) SetRole(ctx context.Context, principal model.Principal, projectID, userID string, input SetProjectMemberRole) (model.ProjectGrant, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.ProjectGrant{}, err
	}
	if err := requireMembershipActor(principal, input.ExpectedUserID); err != nil {
		return model.ProjectGrant{}, err
	}
	id, err := validateMemberMutation(userID, input.Version)
	if err != nil {
		return model.ProjectGrant{}, err
	}
	if input.Role != model.ProjectAdmin && input.Role != model.ProjectMemberRole {
		return model.ProjectGrant{}, invalidInput("Role must be admin or member.")
	}
	var result model.ProjectGrant
	err = s.write(ctx, principal, projectID, func(tx *store.ProjectTx) error {
		member, err := memberMutationTarget(ctx, tx, id, input.Version)
		if err != nil {
			return err
		}
		if member.Grant.Role == input.Role {
			result = member.Grant
			return nil
		}
		member, err = tx.SetMemberRole(ctx, id, input.Role)
		result = member.Grant
		return err
	})
	return result, err
}

func (s *Memberships) Remove(ctx context.Context, principal model.Principal, projectID, userID string, input RemoveProjectMember) error {
	if err := model.RequirePrincipal(principal); err != nil {
		return err
	}
	if err := requireMembershipActor(principal, input.ExpectedUserID); err != nil {
		return err
	}
	id, err := validateMemberMutation(userID, input.Version)
	if err != nil {
		return err
	}
	return s.write(ctx, principal, projectID, func(tx *store.ProjectTx) error {
		if _, err := memberMutationTarget(ctx, tx, id, input.Version); err != nil {
			return err
		}
		return tx.RemoveMember(ctx, id)
	})
}

func (s *Memberships) CreateInvitation(ctx context.Context, principal model.Principal, projectID, expectedUserID string) (MintedInvitation, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return MintedInvitation{}, err
	}
	if err := requireMembershipActor(principal, expectedUserID); err != nil {
		return MintedInvitation{}, err
	}
	id, err := model.CanonicalID(projectID)
	if err != nil {
		return MintedInvitation{}, err
	}
	var result MintedInvitation
	err = s.write(ctx, principal, id, func(tx *store.ProjectTx) error {
		now := s.now().UTC()
		result.Secret = secretutil.Random(invitationPrefix)
		result.Invitation = model.ProjectInvitation{ID: uuid.NewString(), ProjectID: id, CreatedBy: principal.UserID, TokenHash: secretutil.Hash(result.Secret), CreatedAt: now, ExpiresAt: now.Add(InvitationLifetime)}
		return tx.CreateInvitation(ctx, result.Invitation)
	})
	if err != nil {
		return MintedInvitation{}, err
	}
	result.Invitation.TokenHash = nil
	return result, nil
}

func (s *Memberships) ListInvitations(ctx context.Context, principal model.Principal, projectID string) ([]model.ProjectInvitation, error) {
	var invitations []model.ProjectInvitation
	err := s.read(ctx, principal, projectID, true, func(reader store.ProjectReader, _ model.ProjectAccess) error {
		var err error
		invitations, err = reader.Invitations(ctx, projectID, s.now().UTC())
		return err
	})
	return invitations, err
}

func (s *Memberships) RevokeInvitation(ctx context.Context, principal model.Principal, projectID, invitationID, expectedUserID string) error {
	if err := model.RequirePrincipal(principal); err != nil {
		return err
	}
	if err := requireMembershipActor(principal, expectedUserID); err != nil {
		return err
	}
	id, err := model.CanonicalID(invitationID)
	if err != nil {
		return err
	}
	return s.write(ctx, principal, projectID, func(tx *store.ProjectTx) error { return tx.RevokeInvitation(ctx, id, s.now().UTC()) })
}

func invitationAvailable(invitation model.ProjectInvitation, now time.Time) bool {
	return invitation.ConsumedAt == nil && invitation.RevokedAt == nil && invitation.ExpiresAt.After(now)
}

func (s *Memberships) inspect(ctx context.Context, principal model.Principal, secret string, operation func(store.ProjectReader, model.ProjectInvitation) error) error {
	if err := model.RequirePrincipal(principal); err != nil {
		return err
	}
	if !secretutil.Valid(secret, invitationPrefix) {
		return model.InvitationUnavailable(nil)
	}
	var refusal *model.Fault
	err := s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		return completion.Capture(func() error {
			invitation, err := snapshot.ProjectDAO().Invitation(ctx, secretutil.Hash(secret))
			if errors.Is(err, model.ErrNotFound) {
				return model.InvitationUnavailable(err)
			}
			if err != nil {
				return err
			}
			if !invitationAvailable(invitation, s.now().UTC()) {
				return model.InvitationUnavailable(nil)
			}
			return operation(snapshot.ProjectDAO(), invitation)
		}, &refusal)
	})
	if err != nil {
		return err
	}
	if refusal != nil {
		return refusal
	}
	return nil
}

func (s *Memberships) InspectInvitation(ctx context.Context, principal model.Principal, secret string) (InvitationInspection, error) {
	var result InvitationInspection
	err := s.inspect(ctx, principal, secret, func(reader store.ProjectReader, invitation model.ProjectInvitation) error {
		project, err := reader.Project(ctx, invitation.ProjectID)
		if errors.Is(err, model.ErrNotFound) {
			return model.InvitationUnavailable(err)
		}
		if err != nil {
			return err
		}
		result.ProjectID, result.ProjectName = project.ID, project.Name
		access, err := reader.ProjectAccess(ctx, principal, project.ID)
		if errors.Is(err, model.ErrNotFound) {
			return nil
		}
		if err == nil {
			result.Access = &access
			result.DirectGrant = access.DirectGrant
		}
		return err
	})
	return result, err
}

func (s *Memberships) AcceptInvitation(ctx context.Context, principal model.Principal, secret, expectedUserID string) (InvitationAcceptance, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return InvitationAcceptance{}, err
	}
	if err := requireMembershipActor(principal, expectedUserID); err != nil {
		return InvitationAcceptance{}, err
	}
	var projectID string
	if err := s.inspect(ctx, principal, secret, func(_ store.ProjectReader, invitation model.ProjectInvitation) error {
		projectID = invitation.ProjectID
		return nil
	}); err != nil {
		return InvitationAcceptance{}, err
	}
	var result InvitationAcceptance
	var refusal *model.Fault
	err := s.store.WriteProject(ctx, projectID, func(tx *store.ProjectTx) error {
		return completion.Capture(func() error {
			invitation, err := tx.LockInvitation(ctx, secretutil.Hash(secret))
			if errors.Is(err, model.ErrNotFound) {
				return model.InvitationUnavailable(err)
			}
			if err != nil {
				return err
			}
			now := s.now().UTC()
			if !invitationAvailable(invitation, now) {
				return model.InvitationUnavailable(nil)
			}
			member, err := tx.DirectProjectMember(ctx, principal.UserID)
			if err != nil && !errors.Is(err, model.ErrNotFound) {
				return err
			}
			if errors.Is(err, model.ErrNotFound) {
				member, err = tx.AddInvitedMember(ctx, principal.UserID)
				if err != nil {
					return err
				}
				if err := tx.ConsumeInvitation(ctx, invitation.ID, principal.UserID, now); err != nil {
					return err
				}
				result.Joined, result.Consumed = true, true
			}
			result.ProjectID, result.DirectGrant = projectID, member.Grant
			result.Access, err = tx.ProjectAccess(ctx, principal)
			return err
		}, &refusal)
	})
	if errors.Is(err, model.ErrNotFound) {
		return InvitationAcceptance{}, model.InvitationUnavailable(err)
	}
	if err != nil {
		return InvitationAcceptance{}, err
	}
	if refusal != nil {
		return InvitationAcceptance{}, refusal
	}
	return result, nil
}
