package github

import (
	"context"
	"errors"
	"fmt"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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
	return adminRead(ctx, m.db, func(ctx context.Context, dao store.GitHubAppAdminReader) (core.AdminPage, error) {
		return core.ListAdmins(ctx, dao, p, appID, in)
	})
}

func (m *AdminManager) ListAdminInvitations(ctx context.Context, p model.Principal, appID string, in core.ListAppsInput) (core.AdminInvitationPage, error) {
	return adminRead(ctx, m.db, func(ctx context.Context, dao store.GitHubAppAdminReader) (core.AdminInvitationPage, error) {
		return core.ListAdminInvitations(ctx, dao, p, appID, in)
	})
}

func (m *AdminManager) CreateAdminInvitation(ctx context.Context, p model.Principal, appID, expected string) (core.MintedAdminInvitation, error) {
	if err := core.ValidateAdminWrite(p, appID, expected); err != nil {
		return core.MintedAdminInvitation{}, err
	}
	return adminWrite(ctx, m.db, appID, func(ctx context.Context, dao store.GitHubAppAdminWriter) (core.MintedAdminInvitation, error) {
		return core.CreateAdminInvitation(ctx, dao, p, appID)
	})
}

func (m *AdminManager) RevokeAdminInvitation(ctx context.Context, p model.Principal, appID, invitationID, expected string) (core.AdminInvitationRevocation, error) {
	if err := core.ValidateAdminWrite(p, appID, expected); err != nil {
		return core.AdminInvitationRevocation{}, err
	}
	if err := core.ValidateAdminID(invitationID); err != nil {
		return core.AdminInvitationRevocation{}, err
	}
	return adminWrite(ctx, m.db, appID, func(ctx context.Context, dao store.GitHubAppAdminWriter) (core.AdminInvitationRevocation, error) {
		return core.RevokeAdminInvitation(ctx, dao, p, appID, invitationID)
	})
}

func (m *AdminManager) RemoveAdmin(ctx context.Context, p model.Principal, appID, userID string, in core.RemoveAdminInput) (core.AdminRemoval, error) {
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
		return core.RemoveAdmin(ctx, dao, p, appID, userID, in.MembershipVersion)
	})
}

func (m *AdminManager) InspectAdminInvitation(ctx context.Context, p model.Principal, token string) (core.AdminInvitationInspection, error) {
	if err := core.ValidateAdminInvitation(p, token); err != nil {
		return core.AdminInvitationInspection{}, err
	}
	return adminRead(ctx, m.db, func(ctx context.Context, dao store.GitHubAppAdminReader) (core.AdminInvitationInspection, error) {
		return core.InspectAdminInvitation(ctx, dao, p, token)
	})
}

func (m *AdminManager) AcceptAdminInvitation(ctx context.Context, p model.Principal, token, expected string) (core.AdminInvitationAcceptance, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	if err := team.RequireActor(p, expected); err != nil {
		return core.AdminInvitationAcceptance{}, err
	}
	if err := core.ValidateAdminInvitation(p, token); err != nil {
		return core.AdminInvitationAcceptance{}, err
	}
	appID, err := adminRead(ctx, m.db, func(ctx context.Context, dao store.GitHubAppAdminReader) (string, error) {
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
		return core.AcceptAdminInvitation(ctx, dao, p, token)
	})
	var fault *model.Fault
	if errors.As(err, &fault) && fault.Code == "not_found" {
		return core.AdminInvitationAcceptance{}, model.InvitationUnavailable(err)
	}
	return out, err
}
