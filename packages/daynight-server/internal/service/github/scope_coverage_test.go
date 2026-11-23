package github

import (
	"context"
	"errors"
	"log/slog"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestScopedOperationsRejectInvalidAuthorization(t *testing.T) {
	auth := scopeAppAuth(t, "github:read")
	auth.Policy = nil
	ctx := t.Context()
	id := uuid.NewString()
	app := NewScopedAppManager(nil, nil)
	config := NewScopedConfigManager(nil, nil)
	admin := NewAdminManager(nil)
	grant := NewGrantManager(nil, nil)
	project := NewProjectAppManager(nil, nil, slog.Default())
	operations := map[string]func() error{
		"create app": func() error { _, e := app.CreateAppAuthorized(ctx, auth, core.CreateAppInput{}); return e },
		"get app":    func() error { _, e := app.GetAppAuthorized(ctx, auth, id); return e },
		"list apps":  func() error { _, e := app.ListAppsAuthorized(ctx, auth, core.ListAppsInput{}); return e },
		"remove app": func() error { return config.RemoveAppAuthorized(ctx, auth, id, core.RemoveAppInput{}) },
		"list invitations": func() error {
			_, e := admin.ListAdminInvitationsAuthorized(ctx, auth, id, core.ListAppsInput{})
			return e
		},
		"create invitation": func() error {
			_, e := admin.CreateAdminInvitationAuthorized(ctx, auth, id, auth.Principal.UserID)
			return e
		},
		"revoke invitation": func() error {
			_, e := admin.RevokeAdminInvitationAuthorized(ctx, auth, id, id, auth.Principal.UserID)
			return e
		},
		"remove administrator": func() error {
			_, e := admin.RemoveAdminAuthorized(ctx, auth, id, id, core.RemoveAdminInput{})
			return e
		},
		"inspect invitation": func() error { _, e := admin.InspectAdminInvitationAuthorized(ctx, auth, "token"); return e },
		"impact":             func() error { _, e := grant.ImpactAuthorized(ctx, auth, core.AppImpactInput{}); return e },
		"impact projects":    func() error { _, e := grant.ImpactProjectsAuthorized(ctx, auth, core.AppImpactInput{}); return e },
		"preview grant":      func() error { _, e := grant.PreviewGrantAuthorized(ctx, auth, id, id); return e },
		"get grant":          func() error { _, e := grant.GetGrantAuthorized(ctx, auth, id, id); return e },
		"list grants":        func() error { _, e := grant.ListGrantsAuthorized(ctx, auth, id, 1, ""); return e },
		"list team apps":     func() error { _, e := grant.ListTeamAppsAuthorized(ctx, auth, id, 1, ""); return e },
		"create grant":       func() error { _, e := grant.CreateGrantAuthorized(ctx, auth, id, core.CreateGrantInput{}); return e },
		"revoke grant":       func() error { return grant.RevokeGrantAuthorized(ctx, auth, id, id, core.RevokeGrantInput{}) },
		"get connection":     func() error { _, e := project.GetAuthorized(ctx, auth, id); return e },
		"disconnect": func() error {
			_, e := project.DisconnectAuthorized(ctx, auth, id, core.ProjectAppDisconnect{})
			return e
		},
		"settings": func() error { _, e := project.SettingsAuthorized(ctx, auth, id, 1, 15); return e },
		"sync":     func() error { _, e := project.SyncAuthorized(ctx, auth, id, 1, true); return e },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Fatal("invalid credential accepted")
			}
		})
	}
}

type coverageGrantDAO struct {
	store.GitHubGrantReadDAO
	visibilityErr error
	reads         int
}

func (d *coverageGrantDAO) GrantVisibility(context.Context, string, string, string, string, bool) error {
	return d.visibilityErr
}
func (d *coverageGrantDAO) Preview(context.Context, string, string, string) (store.GitHubGrantPreview, error) {
	d.reads++
	return store.GitHubGrantPreview{}, nil
}
func (d *coverageGrantDAO) Grant(context.Context, string, string, string) (store.GitHubTeamGrant, error) {
	d.reads++
	return store.GitHubTeamGrant{}, nil
}
func (d *coverageGrantDAO) Grants(context.Context, string, string, *string, int) (store.GitHubGrantPage, error) {
	d.reads++
	return store.GitHubGrantPage{}, nil
}
func (d *coverageGrantDAO) TeamApps(context.Context, string, string, *string, int) (store.GitHubTeamAppPage, error) {
	d.reads++
	return store.GitHubTeamAppPage{}, nil
}

type coverageGrantStore struct{ dao *coverageGrantDAO }

func (s coverageGrantStore) ReadGitHubGrants(_ context.Context, f func(store.GitHubGrantReadDAO) error) error {
	return f(s.dao)
}
func (s coverageGrantStore) WriteGitHubGrant(context.Context, string, string, string, func(store.GitHubGrantWriteDAO) error) (store.Completion, error) {
	panic("unexpected write")
}

type coverageImpactDAO struct {
	store.GitHubAppImpactDAO
	summaries int
}

func (d *coverageImpactDAO) ImpactVisibility(context.Context, store.GitHubAppImpactQuery) (store.GitHubAppImpact, error) {
	return store.GitHubAppImpact{Version: 1, ImpactVersion: 1}, nil
}
func (d *coverageImpactDAO) Summary(context.Context, store.GitHubAppImpactQuery) (store.GitHubAppImpact, error) {
	d.summaries++
	return store.GitHubAppImpact{Version: 1, ImpactVersion: 1}, nil
}
func (d *coverageImpactDAO) Teams(context.Context, store.GitHubAppImpactQuery) (store.GitHubAppImpactTeams, error) {
	return store.GitHubAppImpactTeams{}, nil
}
func (d *coverageImpactDAO) Projects(context.Context, store.GitHubAppImpactQuery) (store.GitHubAppImpactProjects, error) {
	return store.GitHubAppImpactProjects{}, nil
}

type coverageImpactStore struct{ dao *coverageImpactDAO }

func (s coverageImpactStore) ReadGitHubAppImpact(_ context.Context, f func(store.GitHubAppImpactDAO) error) error {
	return f(s.dao)
}

func TestScopedGrantReadsRequirePermissionBeforeProjection(t *testing.T) {
	ctx := t.Context()
	id, team := uuid.NewString(), uuid.NewString()
	read := scopeAppAuth(t, "github:read")
	denied := scopeAppAuth(t, "github:manage")
	dao := &coverageGrantDAO{}
	impact := &coverageImpactDAO{}
	m := NewGrantManager(coverageGrantStore{dao}, coverageImpactStore{impact})
	operations := map[string]func(model.CredentialAuthorization) error{
		"preview": func(a model.CredentialAuthorization) error {
			_, e := m.PreviewGrantAuthorized(ctx, a, id, team)
			return e
		},
		"grant": func(a model.CredentialAuthorization) error { _, e := m.GetGrantAuthorized(ctx, a, id, team); return e },
		"grants": func(a model.CredentialAuthorization) error {
			_, e := m.ListGrantsAuthorized(ctx, a, id, 10, "")
			return e
		},
		"team": func(a model.CredentialAuthorization) error {
			_, e := m.ListTeamAppsAuthorized(ctx, a, team, 10, "")
			return e
		},
		"impact": func(a model.CredentialAuthorization) error {
			_, e := m.ImpactAuthorized(ctx, a, core.AppImpactInput{AppID: id})
			return e
		},
		"impact projects": func(a model.CredentialAuthorization) error {
			_, e := m.ImpactProjectsAuthorized(ctx, a, core.AppImpactInput{AppID: id})
			return e
		},
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			beforeReads, beforeSummaries := dao.reads, impact.summaries
			scopeAppFault(t, operation(denied), "insufficient_scope")
			if dao.reads != beforeReads || impact.summaries != beforeSummaries {
				t.Fatal("scope denial read projection")
			}
			if err := operation(read); err != nil {
				t.Fatalf("authorized read: %v", err)
			}
		})
	}
	dao.visibilityErr = model.ErrNotFound
	_, err := m.GetGrantAuthorized(ctx, denied, id, team)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "not_found" {
		t.Fatalf("visibility failure: %v", err)
	}
}

type coverageGrantWriter struct {
	store.GitHubGrantWriteDAO
	team      string
	fullReads int
}

func (w *coverageGrantWriter) GrantWriteAdmission(context.Context, string) (store.GitHubGrantWriteAdmission, error) {
	return store.GitHubGrantWriteAdmission{TeamID: w.team, TeamVersion: 1, AppVersion: 1, ImpactVersion: 1, IsAdmin: true}, nil
}
func (w *coverageGrantWriter) RequireLiveGrant(context.Context, string) error { return nil }
func (w *coverageGrantWriter) Facts(context.Context, string) (store.GitHubGrantFacts, error) {
	w.fullReads++
	return store.GitHubGrantFacts{}, nil
}

type coverageGrantWriteStore struct {
	store.GitHubGrantStore
	writer *coverageGrantWriter
}

func (s coverageGrantWriteStore) WriteGitHubGrant(_ context.Context, _, _, _ string, f func(store.GitHubGrantWriteDAO) error) (store.Completion, error) {
	err := f(s.writer)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func TestCreateGrantAuthorizedRequiresBothScopesBeforeFullRead(t *testing.T) {
	team, app, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
	auth := scopeAppAuth(t, "github:read")
	writer := &coverageGrantWriter{team: team}
	m := NewGrantManager(coverageGrantWriteStore{writer: writer}, nil)
	_, err := m.CreateGrantAuthorized(t.Context(), auth, app, core.CreateGrantInput{ID: id, TeamID: team, ExpectedUserID: auth.Principal.UserID, Version: 1, TeamVersion: 1})
	scopeAppFault(t, err, "insufficient_scope")
	if writer.fullReads != 0 {
		t.Fatal("scope denial read complete Team data")
	}
}

func TestObservedProjectAppDAOFailsClosedWithoutAdmissionReader(t *testing.T) {
	dao := &observedProjectAppDAO{GitHubProjectAppWriteDAO: struct{ store.GitHubProjectAppWriteDAO }{}}
	if _, err := dao.ProjectAppAccess(t.Context(), model.Principal{}); err == nil {
		t.Fatal("access accepted missing capability")
	}
	if _, err := dao.ProjectAppVersion(t.Context(), "a", "g", "t"); err == nil {
		t.Fatal("version accepted missing capability")
	}
}
