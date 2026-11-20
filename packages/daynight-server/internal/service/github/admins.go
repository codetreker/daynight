package github

import (
	"context"
	"errors"
	"fmt"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type AdminManager struct{ db store.GitHubAppAdminStore }

func NewAdminManager(db store.GitHubAppAdminStore) *AdminManager { return &AdminManager{db: db} }

func adminRead[T any](ctx context.Context, db store.GitHubAppAdminStore, operation func(context.Context, store.GitHubAppAdminReader) (T, error)) (T, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	var out T
	var refusal *model.Fault
	err := db.ReadGitHubAppAdmins(ctx, func(dao store.GitHubAppAdminReader) error {
		return completion.Capture(func() error { var err error; out, err = operation(ctx, dao); return err }, &refusal)
	})
	if err != nil {
		var zero T
		return zero, err
	}
	if refusal != nil {
		var zero T
		return zero, refusal
	}
	return out, nil
}

func adminWrite[T any](ctx context.Context, db store.GitHubAppAdminStore, appID string, operation func(context.Context, store.GitHubAppAdminWriter) (T, error)) (T, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	var out T
	var refusal *model.Fault
	result, err := db.WriteGitHubAppAdmins(ctx, appID, func(dao store.GitHubAppAdminWriter) error {
		return completion.Capture(func() error { var err error; out, err = operation(ctx, dao); return err }, &refusal)
	})
	var zero T
	if result.Outcome == store.TransactionUnknown {
		return zero, &ManagementError{Code: "github_write_outcome_unknown", Message: "GitHub App write outcome is unknown; inspect current state before deciding what to do.", Cause: err}
	}
	if err != nil {
		if errors.Is(err, model.ErrNotFound) {
			return zero, &model.Fault{Code: "not_found", Message: "GitHub App was not found.", Cause: err}
		}
		return zero, err
	}
	if result.Outcome != store.TransactionCommitted {
		return zero, fmt.Errorf("GitHub App administrator transaction not committed")
	}
	if refusal != nil {
		return zero, refusal
	}
	return out, nil
}

func (m *AdminManager) ListAdmins(ctx context.Context, p model.Principal, appID string, in core.ListAppsInput) (core.AdminPage, error) {
	return m.listAdmins(ctx, p, appID, in, nil)
}

func (m *AdminManager) ListAdminsAuthorized(ctx context.Context, auth model.CredentialAuthorization, appID string, in core.ListAppsInput) (core.AdminPage, error) {
	if err := auth.Validate(); err != nil {
		return core.AdminPage{}, err
	}
	return m.listAdmins(ctx, auth.Principal, appID, in, func() error { return scopeadmission.Require(auth, scopepolicy.GithubRead) })
}

func (m *AdminManager) listAdmins(ctx context.Context, p model.Principal, appID string, in core.ListAppsInput, admit func() error) (core.AdminPage, error) {
	return adminRead(ctx, m.db, func(ctx context.Context, dao store.GitHubAppAdminReader) (core.AdminPage, error) {
		return core.ListAdminsWithAdmission(ctx, dao, p, appID, in, admit)
	})
}
func (m *AdminManager) ListAdminInvitations(ctx context.Context, p model.Principal, appID string, in core.ListAppsInput) (core.AdminInvitationPage, error) {
	return m.listAdminInvitations(ctx, p, appID, in, nil)
}

func (m *AdminManager) ListAdminInvitationsAuthorized(ctx context.Context, auth model.CredentialAuthorization, appID string, in core.ListAppsInput) (core.AdminInvitationPage, error) {
	if err := auth.Validate(); err != nil {
		return core.AdminInvitationPage{}, err
	}
	return m.listAdminInvitations(ctx, auth.Principal, appID, in, func() error { return scopeadmission.Require(auth, scopepolicy.GithubRead) })
}

func (m *AdminManager) listAdminInvitations(ctx context.Context, p model.Principal, appID string, in core.ListAppsInput, admit func() error) (core.AdminInvitationPage, error) {
	return adminRead(ctx, m.db, func(ctx context.Context, dao store.GitHubAppAdminReader) (core.AdminInvitationPage, error) {
		return core.ListAdminInvitationsWithAdmission(ctx, dao, p, appID, in, admit)
	})
}
func (m *AdminManager) CreateAdminInvitation(ctx context.Context, p model.Principal, appID, expected string) (core.MintedAdminInvitation, error) {
	return m.createAdminInvitation(ctx, p, appID, expected, nil)
}

func (m *AdminManager) CreateAdminInvitationAuthorized(ctx context.Context, auth model.CredentialAuthorization, appID, expected string) (core.MintedAdminInvitation, error) {
	if err := auth.Validate(); err != nil {
		return core.MintedAdminInvitation{}, err
	}
	return m.createAdminInvitation(ctx, auth.Principal, appID, expected, func() error { return scopeadmission.Require(auth, scopepolicy.GithubRead, scopepolicy.GithubManage) })
}

func (m *AdminManager) createAdminInvitation(ctx context.Context, p model.Principal, appID, expected string, admit func() error) (core.MintedAdminInvitation, error) {
	if err := core.ValidateAdminWrite(p, appID, expected); err != nil {
		return core.MintedAdminInvitation{}, err
	}
	return adminWrite(ctx, m.db, appID, func(ctx context.Context, dao store.GitHubAppAdminWriter) (core.MintedAdminInvitation, error) {
		return core.CreateAdminInvitationWithAdmission(ctx, dao, p, appID, admit)
	})
}
func (m *AdminManager) RevokeAdminInvitation(ctx context.Context, p model.Principal, appID, invitationID, expected string) (core.AdminInvitationRevocation, error) {
	return m.revokeAdminInvitation(ctx, p, appID, invitationID, expected, nil)
}

func (m *AdminManager) RevokeAdminInvitationAuthorized(ctx context.Context, auth model.CredentialAuthorization, appID, invitationID, expected string) (core.AdminInvitationRevocation, error) {
	if err := auth.Validate(); err != nil {
		return core.AdminInvitationRevocation{}, err
	}
	return m.revokeAdminInvitation(ctx, auth.Principal, appID, invitationID, expected, func() error { return scopeadmission.Require(auth, scopepolicy.GithubRead, scopepolicy.GithubManage) })
}

func (m *AdminManager) revokeAdminInvitation(ctx context.Context, p model.Principal, appID, invitationID, expected string, admit func() error) (core.AdminInvitationRevocation, error) {
	if err := core.ValidateAdminWrite(p, appID, expected); err != nil {
		return core.AdminInvitationRevocation{}, err
	}
	if err := core.ValidateAdminID(invitationID); err != nil {
		return core.AdminInvitationRevocation{}, err
	}
	return adminWrite(ctx, m.db, appID, func(ctx context.Context, dao store.GitHubAppAdminWriter) (core.AdminInvitationRevocation, error) {
		return core.RevokeAdminInvitationWithAdmission(ctx, dao, p, appID, invitationID, admit)
	})
}
func (m *AdminManager) RemoveAdmin(ctx context.Context, p model.Principal, appID, userID string, in core.RemoveAdminInput) (core.AdminRemoval, error) {
	return m.removeAdmin(ctx, p, appID, userID, in, nil)
}

func (m *AdminManager) RemoveAdminAuthorized(ctx context.Context, auth model.CredentialAuthorization, appID, userID string, in core.RemoveAdminInput) (core.AdminRemoval, error) {
	if err := auth.Validate(); err != nil {
		return core.AdminRemoval{}, err
	}
	return m.removeAdmin(ctx, auth.Principal, appID, userID, in, func() error { return scopeadmission.Require(auth, scopepolicy.GithubManage) })
}

func (m *AdminManager) removeAdmin(ctx context.Context, p model.Principal, appID, userID string, in core.RemoveAdminInput, admit func() error) (core.AdminRemoval, error) {
	if err := core.ValidateAdminWrite(p, appID, in.ExpectedUserID); err != nil {
		return core.AdminRemoval{}, err
	}
	if err := core.ValidateAdminID(userID); err != nil {
		return core.AdminRemoval{}, err
	}
	if in.MembershipVersion < 1 {
		return core.AdminRemoval{}, &model.Fault{Code: "invalid_input", Message: "Membership version must be positive."}
	}
	return adminWrite(ctx, m.db, appID, func(ctx context.Context, dao store.GitHubAppAdminWriter) (core.AdminRemoval, error) {
		return core.RemoveAdminWithAdmission(ctx, dao, p, appID, userID, in.MembershipVersion, admit)
	})
}
func (m *AdminManager) InspectAdminInvitation(ctx context.Context, p model.Principal, token string) (core.AdminInvitationInspection, error) {
	return m.inspectAdminInvitation(ctx, p, token, nil)
}

func (m *AdminManager) InspectAdminInvitationAuthorized(ctx context.Context, auth model.CredentialAuthorization, token string) (core.AdminInvitationInspection, error) {
	if err := auth.Validate(); err != nil {
		return core.AdminInvitationInspection{}, err
	}
	return m.inspectAdminInvitation(ctx, auth.Principal, token, func() error { return scopeadmission.Require(auth, scopepolicy.GithubRead) })
}

func (m *AdminManager) inspectAdminInvitation(ctx context.Context, p model.Principal, token string, admit func() error) (core.AdminInvitationInspection, error) {
	if err := core.ValidateAdminInvitation(p, token); err != nil {
		return core.AdminInvitationInspection{}, err
	}
	return adminRead(ctx, m.db, func(ctx context.Context, dao store.GitHubAppAdminReader) (core.AdminInvitationInspection, error) {
		return core.InspectAdminInvitationWithAdmission(ctx, dao, p, token, admit)
	})
}
func (m *AdminManager) AcceptAdminInvitation(ctx context.Context, p model.Principal, token, expected string) (core.AdminInvitationAcceptance, error) {
	return m.acceptAdminInvitation(ctx, p, token, expected, nil)
}

func (m *AdminManager) AcceptAdminInvitationAuthorized(ctx context.Context, auth model.CredentialAuthorization, token, expected string) (core.AdminInvitationAcceptance, error) {
	if err := auth.Validate(); err != nil {
		return core.AdminInvitationAcceptance{}, err
	}
	return m.acceptAdminInvitation(ctx, auth.Principal, token, expected, func(ctx context.Context, dao store.GitHubAppAdminWriter) error {
		if auth.Profile != model.ScopedPATProfile && auth.Profile != model.ScopedMCPProfile {
			return scopeadmission.Require(auth, scopepolicy.GithubRead, scopepolicy.GithubManage)
		}
		reader, ok := dao.(CurrentAdminAuthorization)
		if !ok {
			return fmt.Errorf("GitHub administrator transaction cannot recheck credential policy")
		}
		current, err := reader.CurrentAdminAuthorization(ctx, auth.Principal)
		if err != nil {
			return err
		}
		if current.Principal != auth.Principal || current.Profile != auth.Profile {
			return fmt.Errorf("GitHub administrator credential identity or profile changed")
		}
		if err := scopeadmission.Require(auth, scopepolicy.GithubRead, scopepolicy.GithubManage); err != nil {
			return err
		}
		return scopeadmission.Require(current, scopepolicy.GithubRead, scopepolicy.GithubManage)
	})
}

// CurrentAdminAuthorization reads the original credential's current policy in the final transaction.
type CurrentAdminAuthorization interface {
	CurrentAdminAuthorization(context.Context, model.Principal) (model.CredentialAuthorization, error)
}

func (m *AdminManager) acceptAdminInvitation(ctx context.Context, p model.Principal, token, expected string, admit func(context.Context, store.GitHubAppAdminWriter) error) (core.AdminInvitationAcceptance, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	if err := team.RequireActor(p, expected); err != nil {
		return core.AdminInvitationAcceptance{}, err
	}
	if err := core.ValidateAdminInvitation(p, token); err != nil {
		return core.AdminInvitationAcceptance{}, err
	}
	appID, err := adminRead(ctx, m.db, func(ctx context.Context, dao store.GitHubAppAdminReader) (string, error) {
		if admit != nil {
			visibility, ok := dao.(store.GitHubAppAdminVisibilityDAO)
			if !ok {
				return "", fmt.Errorf("GitHub administrator snapshot cannot check invitation availability")
			}
			ref, err := visibility.AvailableAdminInvitation(ctx, secretutil.Hash(token))
			if errors.Is(err, model.ErrNotFound) {
				return "", model.InvitationUnavailable(err)
			}
			return ref.AppID, err
		}
		i, err := dao.InvitationByHash(ctx, secretutil.Hash(token))
		if errors.Is(err, model.ErrNotFound) {
			return "", model.InvitationUnavailable(err)
		}
		return i.AppID, err
	})
	if err != nil {
		return core.AdminInvitationAcceptance{}, err
	}
	out, err := adminWrite(ctx, m.db, appID, func(ctx context.Context, dao store.GitHubAppAdminWriter) (core.AdminInvitationAcceptance, error) {
		var check func() error
		if admit != nil {
			check = func() error { return admit(ctx, dao) }
		}
		return core.AcceptAdminInvitationWithAdmission(ctx, dao, p, token, check)
	})
	var fault *model.Fault
	if errors.As(err, &fault) && fault.Code == "not_found" {
		return core.AdminInvitationAcceptance{}, model.InvitationUnavailable(err)
	}
	return out, err
}
