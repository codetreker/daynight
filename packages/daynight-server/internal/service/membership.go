package service

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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
	Invitation core.ProjectInvitation
	Secret     string
}

type InvitationInspection struct {
	ProjectID   string
	ProjectName string
	DirectGrant *core.ProjectGrant
	Access      *core.ProjectAccess
}

type InvitationAcceptance struct {
	ProjectID   string
	DirectGrant core.ProjectGrant
	Access      core.ProjectAccess
	Joined      bool
	Consumed    bool
}

func requirePrincipal(principal core.Principal) error {
	if principal.Kind != core.SessionCredential && principal.Kind != core.PATCredential {
		return unauthenticated(nil)
	}
	if _, err := CanonicalID(principal.CredentialID); err != nil {
		return unauthenticated(nil)
	}
	if _, err := CanonicalID(principal.UserID); err != nil {
		return unauthenticated(nil)
	}
	return nil
}

func projectNotFound(cause error) error {
	return &Fault{Code: "not_found", Message: "Project was not found.", Cause: cause}
}

func membershipLookupError(err error) error {
	if errors.Is(err, core.ErrNotFound) {
		return projectNotFound(err)
	}
	return err
}

func RequireProjectRead(ctx context.Context, snapshot *store.Snapshot, principal core.Principal, projectID string) (core.ProjectAccess, error) {
	if err := requirePrincipal(principal); err != nil {
		return core.ProjectAccess{}, err
	}
	id, err := CanonicalID(projectID)
	if err != nil {
		return core.ProjectAccess{}, err
	}
	access, err := snapshot.ProjectAccess(ctx, principal, id)
	return access, membershipLookupError(err)
}

func RequireProjectWrite(ctx context.Context, tx *store.ProjectTx, principal core.Principal) (core.ProjectAccess, error) {
	if err := requirePrincipal(principal); err != nil {
		return core.ProjectAccess{}, err
	}
	access, err := tx.ProjectAccess(ctx, principal)
	return access, membershipLookupError(err)
}

func requireProjectAdmin(access core.ProjectAccess) error {
	if access.Role != core.ProjectAdmin {
		return &Fault{Code: "forbidden", Message: "Project administrator access is required."}
	}
	return nil
}

// Domain refusals still complete the transaction, so cancellation and commit errors remain visible.
func completeMembershipOperation(operation func() error, refusal **Fault) error {
	err := operation()
	if errors.As(err, refusal) {
		return nil
	}
	return err
}

func (s *Memberships) read(ctx context.Context, principal core.Principal, projectID string, admin bool, operation func(*store.Snapshot, core.ProjectAccess) error) error {
	if err := requirePrincipal(principal); err != nil {
		return err
	}
	id, err := CanonicalID(projectID)
	if err != nil {
		return err
	}
	var refusal *Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		return completeMembershipOperation(func() error {
			access, err := RequireProjectRead(ctx, snapshot, principal, id)
			if err != nil {
				return err
			}
			if admin {
				if err := requireProjectAdmin(access); err != nil {
					return err
				}
			}
			return operation(snapshot, access)
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

func (s *Memberships) write(ctx context.Context, principal core.Principal, projectID string, operation func(*store.ProjectTx) error) error {
	if err := requirePrincipal(principal); err != nil {
		return err
	}
	id, err := CanonicalID(projectID)
	if err != nil {
		return err
	}
	var refusal *Fault
	err = s.store.WriteProject(ctx, id, func(tx *store.ProjectTx) error {
		return completeMembershipOperation(func() error {
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
	Items       []core.ProjectParticipant
	ActorAccess core.ProjectAccess
}

func (s *Memberships) List(ctx context.Context, principal core.Principal, projectID string) ([]core.ProjectParticipant, error) {
	result, err := s.ListWithAccess(ctx, principal, projectID)
	return result.Items, err
}

func (s *Memberships) ListWithAccess(ctx context.Context, principal core.Principal, projectID string) (ProjectParticipants, error) {
	var result ProjectParticipants
	err := s.read(ctx, principal, projectID, false, func(snapshot *store.Snapshot, access core.ProjectAccess) error {
		var err error
		result.ActorAccess = access
		result.Items, err = snapshot.ProjectParticipants(ctx, projectID)
		return err
	})
	if err != nil {
		return ProjectParticipants{}, err
	}
	return result, nil
}

func memberMutationTarget(ctx context.Context, tx *store.ProjectTx, userID string, version int64) (core.ProjectMember, error) {
	member, err := tx.DirectProjectMember(ctx, userID)
	if errors.Is(err, core.ErrNotFound) {
		return core.ProjectMember{}, &Fault{Code: "not_found", Message: "Project member was not found.", Cause: err}
	}
	if err != nil {
		return core.ProjectMember{}, err
	}
	if member.Grant.Version != version {
		return core.ProjectMember{}, &Fault{Code: "version_conflict", Message: "Member version does not match."}
	}
	return member, nil
}

func validateMemberMutation(userID string, version int64) (string, error) {
	id, err := CanonicalID(userID)
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
	Role           core.ProjectRole
	ExpectedUserID string
}

type RemoveProjectMember struct {
	Version        int64
	ExpectedUserID string
}

func requireMembershipActor(principal core.Principal, expectedUserID string) error {
	expected, err := CanonicalID(expectedUserID)
	if err != nil {
		return err
	}
	if expected != expectedUserID {
		return invalidInput("expectedUserId must be a canonical user UUID")
	}
	if expected != principal.UserID {
		return &Fault{Code: "identity_mismatch", Message: "The signed-in account changed. Review the project authorization again."}
	}
	return nil
}

func (s *Memberships) SetRole(ctx context.Context, principal core.Principal, projectID, userID string, input SetProjectMemberRole) (core.ProjectGrant, error) {
	if err := requirePrincipal(principal); err != nil {
		return core.ProjectGrant{}, err
	}
	if err := requireMembershipActor(principal, input.ExpectedUserID); err != nil {
		return core.ProjectGrant{}, err
	}
	id, err := validateMemberMutation(userID, input.Version)
	if err != nil {
		return core.ProjectGrant{}, err
	}
	if input.Role != core.ProjectAdmin && input.Role != core.ProjectMemberRole {
		return core.ProjectGrant{}, invalidInput("Role must be admin or member.")
	}
	var result core.ProjectGrant
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

func (s *Memberships) Remove(ctx context.Context, principal core.Principal, projectID, userID string, input RemoveProjectMember) error {
	if err := requirePrincipal(principal); err != nil {
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

func (s *Memberships) CreateInvitation(ctx context.Context, principal core.Principal, projectID, expectedUserID string) (MintedInvitation, error) {
	if err := requirePrincipal(principal); err != nil {
		return MintedInvitation{}, err
	}
	if err := requireMembershipActor(principal, expectedUserID); err != nil {
		return MintedInvitation{}, err
	}
	id, err := CanonicalID(projectID)
	if err != nil {
		return MintedInvitation{}, err
	}
	var result MintedInvitation
	err = s.write(ctx, principal, id, func(tx *store.ProjectTx) error {
		now := s.now().UTC()
		result.Secret = randomSecret(invitationPrefix)
		result.Invitation = core.ProjectInvitation{ID: uuid.NewString(), ProjectID: id, CreatedBy: principal.UserID, TokenHash: secretHash(result.Secret), CreatedAt: now, ExpiresAt: now.Add(InvitationLifetime)}
		return tx.CreateInvitation(ctx, result.Invitation)
	})
	if err != nil {
		return MintedInvitation{}, err
	}
	result.Invitation.TokenHash = nil
	return result, nil
}

func (s *Memberships) ListInvitations(ctx context.Context, principal core.Principal, projectID string) ([]core.ProjectInvitation, error) {
	var invitations []core.ProjectInvitation
	err := s.read(ctx, principal, projectID, true, func(snapshot *store.Snapshot, _ core.ProjectAccess) error {
		var err error
		invitations, err = snapshot.Invitations(ctx, projectID, s.now().UTC())
		return err
	})
	return invitations, err
}

func (s *Memberships) RevokeInvitation(ctx context.Context, principal core.Principal, projectID, invitationID, expectedUserID string) error {
	if err := requirePrincipal(principal); err != nil {
		return err
	}
	if err := requireMembershipActor(principal, expectedUserID); err != nil {
		return err
	}
	id, err := CanonicalID(invitationID)
	if err != nil {
		return err
	}
	return s.write(ctx, principal, projectID, func(tx *store.ProjectTx) error { return tx.RevokeInvitation(ctx, id, s.now().UTC()) })
}

func invitationUnavailable(cause error) error {
	return &Fault{Code: "invitation_unavailable", Message: "Invitation is unavailable.", Cause: cause}
}

func invitationAvailable(invitation core.ProjectInvitation, now time.Time) bool {
	return invitation.ConsumedAt == nil && invitation.RevokedAt == nil && invitation.ExpiresAt.After(now)
}

func (s *Memberships) inspect(ctx context.Context, principal core.Principal, secret string, operation func(*store.Snapshot, core.ProjectInvitation) error) error {
	if err := requirePrincipal(principal); err != nil {
		return err
	}
	if !validSecret(secret, invitationPrefix) {
		return invitationUnavailable(nil)
	}
	var refusal *Fault
	err := s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		return completeMembershipOperation(func() error {
			invitation, err := snapshot.Invitation(ctx, secretHash(secret))
			if errors.Is(err, core.ErrNotFound) {
				return invitationUnavailable(err)
			}
			if err != nil {
				return err
			}
			if !invitationAvailable(invitation, s.now().UTC()) {
				return invitationUnavailable(nil)
			}
			return operation(snapshot, invitation)
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

func (s *Memberships) InspectInvitation(ctx context.Context, principal core.Principal, secret string) (InvitationInspection, error) {
	var result InvitationInspection
	err := s.inspect(ctx, principal, secret, func(snapshot *store.Snapshot, invitation core.ProjectInvitation) error {
		project, err := snapshot.Project(ctx, invitation.ProjectID)
		if errors.Is(err, core.ErrNotFound) {
			return invitationUnavailable(err)
		}
		if err != nil {
			return err
		}
		result.ProjectID, result.ProjectName = project.ID, project.Name
		access, err := snapshot.ProjectAccess(ctx, principal, project.ID)
		if errors.Is(err, core.ErrNotFound) {
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

func (s *Memberships) AcceptInvitation(ctx context.Context, principal core.Principal, secret, expectedUserID string) (InvitationAcceptance, error) {
	if err := requirePrincipal(principal); err != nil {
		return InvitationAcceptance{}, err
	}
	if err := requireMembershipActor(principal, expectedUserID); err != nil {
		return InvitationAcceptance{}, err
	}
	var projectID string
	if err := s.inspect(ctx, principal, secret, func(_ *store.Snapshot, invitation core.ProjectInvitation) error {
		projectID = invitation.ProjectID
		return nil
	}); err != nil {
		return InvitationAcceptance{}, err
	}
	var result InvitationAcceptance
	var refusal *Fault
	err := s.store.WriteProject(ctx, projectID, func(tx *store.ProjectTx) error {
		return completeMembershipOperation(func() error {
			invitation, err := tx.LockInvitation(ctx, secretHash(secret))
			if errors.Is(err, core.ErrNotFound) {
				return invitationUnavailable(err)
			}
			if err != nil {
				return err
			}
			now := s.now().UTC()
			if !invitationAvailable(invitation, now) {
				return invitationUnavailable(nil)
			}
			member, err := tx.DirectProjectMember(ctx, principal.UserID)
			if err != nil && !errors.Is(err, core.ErrNotFound) {
				return err
			}
			if errors.Is(err, core.ErrNotFound) {
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
	if errors.Is(err, core.ErrNotFound) {
		return InvitationAcceptance{}, invitationUnavailable(err)
	}
	if err != nil {
		return InvitationAcceptance{}, err
	}
	if refusal != nil {
		return InvitationAcceptance{}, refusal
	}
	return result, nil
}
