package github

import (
	"context"
	"errors"
	"fmt"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
)

// GrantManager coordinates App grant operations using their dedicated scopes.
type GrantManager struct {
	grants store.GitHubGrantStore
	impact store.GitHubAppImpactStore
}

func NewGrantManager(grants store.GitHubGrantStore, impact store.GitHubAppImpactStore) *GrantManager {
	return &GrantManager{grants: grants, impact: impact}
}

func (m *GrantManager) Impact(ctx context.Context, p model.Principal, in core.AppImpactInput) (core.AppImpactPage, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	var result core.AppImpactPage
	var refusal *model.Fault
	err := m.impact.ReadGitHubAppImpact(ctx, func(dao store.GitHubAppImpactDAO) error {
		return completion.Capture(func() error { var e error; result, e = core.ReadAppImpact(ctx, dao, p, in); return e }, &refusal)
	})
	if err != nil {
		return core.AppImpactPage{}, err
	}
	if refusal != nil {
		return core.AppImpactPage{}, refusal
	}
	return result, nil
}

func (m *GrantManager) ImpactProjects(ctx context.Context, p model.Principal, in core.AppImpactInput) (core.AppImpactProjectsPage, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	var result core.AppImpactProjectsPage
	var refusal *model.Fault
	err := m.impact.ReadGitHubAppImpact(ctx, func(dao store.GitHubAppImpactDAO) error {
		return completion.Capture(func() error { var e error; result, e = core.ReadAppImpactProjects(ctx, dao, p, in); return e }, &refusal)
	})
	if err != nil {
		return core.AppImpactProjectsPage{}, err
	}
	if refusal != nil {
		return core.AppImpactProjectsPage{}, refusal
	}
	return result, nil
}

func grantCompletion(c store.Completion, err error) error {
	if c.Outcome == store.TransactionUnknown {
		return &ManagementError{Code: "github_write_outcome_unknown", Message: "GitHub grant write outcome is unknown; inspect the current resource before deciding what to do.", Cause: err}
	}
	if err != nil {
		var tx *store.TransactionError
		var fault *model.Fault
		failed, _ := store.DatabaseErrorFacts(err)
		if !failed && !errors.As(err, &fault) && errors.Is(err, model.ErrNotFound) && c.Outcome == store.TransactionNotCommitted && errors.As(err, &tx) && tx.Phase == "operation" && !tx.CleanupFailed && tx.Outcome == store.TransactionNotCommitted {
			return &model.Fault{Code: "not_found", Message: "GitHub App or Team was not found.", Cause: err}
		}
		return err
	}
	if c.Outcome != store.TransactionCommitted {
		return fmt.Errorf("GitHub grant transaction not committed")
	}
	return nil
}

func (m *GrantManager) PreviewGrant(ctx context.Context, p model.Principal, appID, teamID string) (store.GitHubGrantPreview, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	var result store.GitHubGrantPreview
	var refusal *model.Fault
	err := m.grants.ReadGitHubGrants(ctx, func(dao store.GitHubGrantReadDAO) error {
		return completion.Capture(func() error { var e error; result, e = core.PreviewGrant(ctx, dao, p, appID, teamID); return e }, &refusal)
	})
	if err != nil {
		return store.GitHubGrantPreview{}, err
	}
	if refusal != nil {
		return store.GitHubGrantPreview{}, refusal
	}
	return result, nil
}
func (m *GrantManager) GetGrant(ctx context.Context, p model.Principal, appID, grantID string) (store.GitHubTeamGrant, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	var result store.GitHubTeamGrant
	var refusal *model.Fault
	err := m.grants.ReadGitHubGrants(ctx, func(dao store.GitHubGrantReadDAO) error {
		return completion.Capture(func() error { var e error; result, e = core.GetGrant(ctx, dao, p, appID, grantID); return e }, &refusal)
	})
	if err != nil {
		return store.GitHubTeamGrant{}, err
	}
	if refusal != nil {
		return store.GitHubTeamGrant{}, refusal
	}
	return result, nil
}
func pageRequest(limit int, cursor string) model.PageRequest {
	var c *string
	if cursor != "" {
		c = &cursor
	}
	return model.PageRequest{Limit: limit, Cursor: c}
}
func (m *GrantManager) ListGrants(ctx context.Context, p model.Principal, appID string, limit int, cursor string) (core.GrantPage, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	var result core.GrantPage
	var refusal *model.Fault
	err := m.grants.ReadGitHubGrants(ctx, func(dao store.GitHubGrantReadDAO) error {
		return completion.Capture(func() error {
			var e error
			result, e = core.ListGrants(ctx, dao, p, appID, pageRequest(limit, cursor))
			return e
		}, &refusal)
	})
	if err != nil {
		return core.GrantPage{}, err
	}
	if refusal != nil {
		return core.GrantPage{}, refusal
	}
	return result, nil
}
func (m *GrantManager) ListTeamApps(ctx context.Context, p model.Principal, teamID string, limit int, cursor string) (core.TeamAppPage, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	var result core.TeamAppPage
	var refusal *model.Fault
	err := m.grants.ReadGitHubGrants(ctx, func(dao store.GitHubGrantReadDAO) error {
		return completion.Capture(func() error {
			var e error
			result, e = core.ListTeamApps(ctx, dao, p, teamID, pageRequest(limit, cursor))
			return e
		}, &refusal)
	})
	if err != nil {
		return core.TeamAppPage{}, err
	}
	if refusal != nil {
		return core.TeamAppPage{}, refusal
	}
	return result, nil
}
func (m *GrantManager) CreateGrant(ctx context.Context, p model.Principal, appID string, in core.CreateGrantInput) (store.GitHubTeamGrant, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	if err := core.ValidateCreateGrant(p, appID, in); err != nil {
		return store.GitHubTeamGrant{}, err
	}
	var result store.GitHubTeamGrant
	c, err := m.grants.WriteGitHubGrant(ctx, in.TeamID, appID, p.UserID, func(dao store.GitHubGrantWriteDAO) error {
		var e error
		result, e = core.CreateGrant(ctx, dao, p, in)
		return e
	})
	if err = grantCompletion(c, err); err != nil {
		return store.GitHubTeamGrant{}, err
	}
	return result, nil
}
func (m *GrantManager) RevokeGrant(ctx context.Context, p model.Principal, appID, grantID string, in core.RevokeGrantInput) error {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	if err := core.ValidateRevokeGrant(p, appID, grantID, in); err != nil {
		return err
	}
	location, err := m.locateGrant(ctx, p, appID, grantID, in)
	if err != nil {
		return err
	}
	c, err := m.grants.WriteGitHubGrant(ctx, location.TeamID, appID, p.UserID, func(dao store.GitHubGrantWriteDAO) error { return core.RevokeGrant(ctx, dao, p, grantID, in) })
	result := grantCompletion(c, err)
	// Team deletion can revoke the grant while the transaction waits for the
	// Team root. Re-read after a confirmed missing-root refusal.
	var tx *store.TransactionError
	failed, _ := store.DatabaseErrorFacts(err)
	if c.Outcome == store.TransactionNotCommitted && !failed && errors.Is(err, store.ErrGitHubGrantTeamRootMissing) && errors.As(err, &tx) && tx.Phase == "operation" && !tx.CleanupFailed && tx.Outcome == store.TransactionNotCommitted {
		latest, readErr := m.locateGrant(ctx, p, appID, grantID, in)
		if readErr != nil {
			return readErr
		}
		if latest.Revoked {
			return grantLocationConflict(latest, in)
		}
		return fmt.Errorf("active GitHub grant references a missing Team root")
	}
	return result
}

func grantLocationConflict(location store.GitHubGrantLocation, in core.RevokeGrantInput) error {
	if location.AppVersion != in.Version {
		return &model.Fault{Code: "version_conflict", Message: "App version changed."}
	}
	if location.ImpactVersion != in.ImpactVersion {
		return &model.Fault{Code: "impact_changed", Message: "App impact changed."}
	}
	return &model.Fault{Code: "github_grant_changed", Message: "Grant changed."}
}

func (m *GrantManager) locateGrant(ctx context.Context, p model.Principal, appID, grantID string, in core.RevokeGrantInput) (store.GitHubGrantLocation, error) {
	var location store.GitHubGrantLocation
	var refusal *model.Fault
	err := m.grants.ReadGitHubGrants(ctx, func(dao store.GitHubGrantReadDAO) error {
		return completion.Capture(func() error {
			var e error
			location, e = dao.Locate(ctx, appID, p.UserID, grantID)
			failed, _ := store.DatabaseErrorFacts(e)
			if !failed && errors.Is(e, model.ErrNotFound) {
				if location.AppVersion == 0 {
					return &model.Fault{Code: "not_found", Message: "App was not found.", Cause: e}
				}
				return grantLocationConflict(location, in)
			}
			return e
		}, &refusal)
	})
	if err != nil {
		return store.GitHubGrantLocation{}, err
	}
	if refusal != nil {
		return store.GitHubGrantLocation{}, refusal
	}
	return location, nil
}
